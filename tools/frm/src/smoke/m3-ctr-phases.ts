import { existsSync, readFileSync } from "node:fs";
import { err, newId, ok, type Result } from "@bayon/core";
import { getSession } from "@bayon/db";
import { seedConfig } from "@bayon/db/operator";
import {
  RunnerConformanceResult,
  type EventItem,
  type ExecutorView,
  type GateView,
  type TicketView,
} from "@bayon/proto";
import { z } from "zod";
import {
  CTR_CONFORMANCE_TIMEOUT_MS,
  CTR_HEALTH_TIMEOUT_MS,
  EVENTS_TIMEOUT_MS,
  M3_GATE_TIMEOUT_MS,
} from "./budget.js";
import { pollUntil } from "./deadline.js";
import { terminalOf } from "./follow.js";
import { refuse, verdict } from "./harness.js";
import {
  artifactProblems,
  attemptsOf,
  blockingProblems,
  evidenceProblems,
  gateProblems,
  resolvedProblems,
  roundsProblems,
} from "./m3-assertions.js";
import { M3_CALLS } from "./m3-config.js";
import {
  absentProblems,
  conformance11Problems,
  digestOf,
  egressProblems,
  healthProblems,
  inspectProblems,
  mcpRoundTripProblems,
  noFilesProblems,
  reachedProblems,
  refProblems,
} from "./m3-ctr-assertions.js";
import {
  M3C,
  TRIVIAL_TICKET,
  probeRows,
  probeSpawn,
  ticketRows,
} from "./m3-ctr-config.js";
import {
  containersOf,
  egressProbe,
  filesContaining,
  gatewayName,
  inspectAll,
  type CtrRun,
} from "./m3-ctr-host.js";
import { waitFor } from "./m2-reads.js";
import {
  builderStep,
  decided,
  gatesUntil,
  landedStep,
  operatorStep,
  supervisorStep,
  type BuilderRun,
} from "./m3-reads.js";
import { commandDone, sessionIn, type World } from "./phases.js";

// `FRM_CONTAINER=1 frm smoke --m3 --executor <id>` (plan "M3 — Container run"): the reviewer's
// runner placed on a container executor on the shared docker host. (C0) the executor healthy with
// its /mcp tunnel; (C1) a session there with a `ctr:` ref whose MCP call comes back through the
// tunnel; (C2) the canary secret absent from docker inspect, the remote disk and the raw log;
// (C3) its container reaped; (C4) egress only to the allowlist; (1c) conformance there, test 11
// through the tunnel; then steps 3–5 on a trivial ticket with its code review on the container.

export interface CtrOptions {
  readonly run: CtrRun;
  /** The runner whose stand-in declares outputSchema: the container's reviewer. */
  readonly schemaRunner: string;
}

const key = (w: World, what: string) =>
  `smoke:m3c:${what}:${newId(w.h.clock.now())}`;

/** C0: one health check asked for every 10 s until the executor is healthy with its tunnel up. */
async function healthy(w: World, o: CtrOptions): Promise<ExecutorView> {
  const id = o.run.executorId;
  let asked = Number.NEGATIVE_INFINITY;
  let last = "not checked";
  return w.h.step(
    `(C0) ${id} healthy: its /mcp tunnel up, /mcp answering 401 through the gateway`,
    () =>
      pollUntil(
        {
          clock: w.h.clock,
          timeoutMs: CTR_HEALTH_TIMEOUT_MS,
          intervalMs: 500,
          what: `${id} healthy`,
          detail: () => last,
        },
        async () => {
          if (w.h.clock.now() - asked >= 10_000) {
            asked = w.h.clock.now();
            const posted = await w.api.executorHealth(id, key(w, "health"));
            if (!posted.ok) return posted;
            const done = await commandDone(w, posted.value.command_id);
            if (!done.ok) return done;
          }
          const views = await w.api.executors();
          if (!views.ok) return views;
          const view = views.value.executors.find((e) => e.id === id);
          const problems = healthProblems(view);
          last = problems.join("; ");
          return ok(problems.length === 0 ? view : undefined);
        },
      ),
  );
}

/** The run's terminal event arrived: every event of the session so far. */
const toTerminal = (w: World, sid: string): Promise<Result<EventItem[]>> =>
  waitFor(w, `session ${sid}'s terminal`, EVENTS_TIMEOUT_MS, async () => {
    const stored = await w.api.events(sid);
    if (!stored.ok) return stored;
    return ok(
      terminalOf(stored.value) === undefined ? undefined : stored.value,
    );
  });

/** C1: a session of the reviewer's runner on the container, idle after its one run. */
async function probeSession(w: World, o: CtrOptions): Promise<string> {
  const nonce = `frm-${newId(w.h.clock.now()).slice(-10).toLowerCase()}`;
  const sid = await w.h.step(
    `(C1) POST /sessions: the reviewer's runner on ${o.run.executorId}`,
    async () => {
      const accepted = await w.api.spawn(
        probeSpawn(o.schemaRunner, o.run.executorId, nonce),
        key(w, "probe"),
      );
      if (!accepted.ok) return accepted;
      w.h.track(accepted.value.session_id);
      const done = await commandDone(w, accepted.value.command_id);
      return done.ok ? ok(accepted.value.session_id) : done;
    },
  );
  await w.h.step(
    `(C1) ${sid}: a ctr: ref, its root in the container, its MCP call back through the tunnel`,
    async () => {
      const events = await toTerminal(w, sid);
      if (!events.ok) return events;
      const idle = await sessionIn(w, sid, "idle");
      if (!idle.ok) return idle;
      const t = terminalOf(events.value);
      return verdict([
        ...refProblems(idle.value.executor_ref, o.run.executorId),
        ...(idle.value.session_root === `/frm/s/${sid}`
          ? []
          : [`its root is ${idle.value.session_root}, not /frm/s/${sid}`]),
        ...(t?.payload.outcome === "ok"
          ? []
          : [`its run ended ${t?.payload.outcome ?? "with no terminal"}`]),
        ...mcpRoundTripProblems(events.value, M3C.mcpTool),
      ]);
    },
  );
  return sid;
}

/** C2: the canary reached the runner, yet is in no inspect, no remote file and no raw log. */
async function canary(w: World, o: CtrOptions, sid: string): Promise<void> {
  const { run } = o;
  await w.h.step(
    "(C2) the canary reached the runner (its digest in the session's root) and is in no docker inspect, no remote file, no raw log",
    async () => {
      const mine = await containersOf(run, sid);
      if (!mine.ok) return mine;
      const inspected = await inspectAll(run);
      if (!inspected.ok) return inspected;
      const reached = await filesContaining(
        run,
        `${run.root}/work/${sid}`,
        digestOf(run.canary),
      );
      if (!reached.ok) return reached;
      const onDisk = await filesContaining(run, run.root, run.canary);
      if (!onDisk.ok) return onDisk;
      const s = await getSession(w.db, sid);
      if (!s.ok) return s;
      const rawLog = existsSync(s.value.raw_log_path)
        ? readFileSync(s.value.raw_log_path, "utf8")
        : "";
      w.h.note(
        `canary: ${mine.value.length} session container(s); digest in ${reached.value.length} file(s)`,
      );
      return verdict([
        ...(mine.value.length === 0 ? ["the session has no container"] : []),
        ...(rawLog === "" ? [`no raw log at ${s.value.raw_log_path}`] : []),
        ...reachedProblems(reached.value),
        ...inspectProblems(inspected.value, run.canary, mine.value),
        ...noFilesProblems(`the remote disk under ${run.root}`, onDisk.value),
        ...absentProblems("the session's raw log", rawLog, run.canary),
      ]);
    },
  );
}

/** Polls until the session's labelled containers are gone. */
const reaped = (w: World, run: CtrRun, sid: string): Promise<Result<true>> =>
  waitFor(w, `${sid}'s container reaped`, M3_GATE_TIMEOUT_MS, async () => {
    const left = await containersOf(run, sid);
    if (!left.ok) return left;
    return ok(left.value.length === 0 ? true : undefined);
  });

/** C3: stopped, its labelled container is reaped. */
async function stopped(w: World, o: CtrOptions, sid: string): Promise<void> {
  await w.h.step(
    `(C3) ${sid} stopped: its labelled container reaped`,
    async () => {
      const stop = await w.api.stop(sid, "graceful", key(w, "stop"));
      if (!stop.ok) return stop;
      const done = await commandDone(w, stop.value.command_id);
      if (!done.ok) return done;
      return reaped(w, o.run, sid);
    },
  );
}

const GatewayConfig = z.looseObject({
  image: z.string(),
  gateway: z.looseObject({ proxy_port: z.int() }).optional(),
});

/** C4: through the gateway the allowed host answers 200 and another 403; no direct route out. */
async function egress(
  w: World,
  o: CtrOptions,
  view: ExecutorView,
): Promise<void> {
  const { run } = o;
  await w.h.step(
    `(C4) egress from ${run.network}: ${M3C.egressAllowed} through the gateway, ${M3C.egressRefused} refused, no direct route`,
    async () => {
      const config = GatewayConfig.safeParse(view.config);
      if (!config.success)
        return err(refuse("the executor's config names no image"));
      const gateway = await gatewayName(run);
      if (!gateway.ok) return gateway;
      const probe = (host: string, direct: boolean) =>
        egressProbe(run, {
          image: config.data.image,
          gateway: gateway.value,
          proxyPort: config.data.gateway?.proxy_port ?? 8888,
          host,
          direct,
        });
      const allowed = await probe(M3C.egressAllowed, false);
      if (!allowed.ok) return allowed;
      const refused = await probe(M3C.egressRefused, false);
      if (!refused.ok) return refused;
      const direct = await probe(M3C.directTarget, true);
      if (!direct.ok) return direct;
      w.h.note(`egress: ${allowed.value} | ${refused.value} | ${direct.value}`);
      return verdict(
        egressProblems(
          {
            allowed: allowed.value,
            refused: refused.value,
            direct: direct.value,
          },
          { allowed: M3C.egressAllowed, refused: M3C.egressRefused },
        ),
      );
    },
  );
}

/** (1c) The suite for the reviewer's runner on the container: a report, test 11 through the tunnel. */
async function conformance(w: World, o: CtrOptions): Promise<void> {
  const id = o.run.executorId;
  await w.h.step(
    `(1c) POST /runners/${o.schemaRunner}/conformance on ${id}: a report, test 11 (MCP) through the tunnel, the pair gate-eligible`,
    async () => {
      // The model the reviewer's profile runs there: the cheapest tier (m3-config).
      const runners = await w.api.runners();
      if (!runners.ok) return runners;
      const cheap = runners.value.runners
        .find((r) => r.id === o.schemaRunner)
        ?.models.find((m) => m.tier === "cheap");
      if (cheap === undefined)
        return err(refuse(`${o.schemaRunner} has no active cheap model`));
      const accepted = await w.api.runnerConformance(
        o.schemaRunner,
        { executor_id: id, model_id: cheap.id },
        key(w, "conformance"),
      );
      if (!accepted.ok) return accepted;
      const done = await commandDone(
        w,
        accepted.value.command_id,
        CTR_CONFORMANCE_TIMEOUT_MS,
      );
      if (!done.ok)
        return err(
          refuse(
            `runner.conformance on ${id} did not run: ${done.error.message}`,
          ),
        );
      const r = RunnerConformanceResult.safeParse(done.value.result);
      if (!r.success) return err(refuse("not a conformance result"));
      return verdict(conformance11Problems(r.data, id));
    },
  );
}

/** A decided gate's reviewer: on the container, and its labelled container reaped after. */
async function onContainer(
  w: World,
  o: CtrOptions,
  g: GateView | undefined,
): Promise<Result<void>> {
  if (g?.session_id === null || g?.session_id === undefined)
    return err(refuse("the gate names no reviewer session"));
  const s = await getSession(w.db, g.session_id);
  if (!s.ok) return s;
  const ref = refProblems(s.value.executor_ref, o.run.executorId);
  if (ref.length > 0) return verdict(ref);
  const gone = await reaped(w, o.run, g.session_id);
  return gone.ok ? ok(undefined) : gone;
}

async function fileTicket(w: World, o: CtrOptions): Promise<TicketView> {
  const t = await w.h.step("POST /tickets (Tc, trivial)", async () => {
    const filed = await w.api.createTicket(TRIVIAL_TICKET);
    if (!filed.ok) return filed;
    return filed.value.non_trivial
      ? err(refuse("Tc came out non-trivial"))
      : ok(filed.value);
  });
  await operatorStep(w, `Tc ${t.key} prioritized`, t.id, { to: "prioritized" });
  await operatorStep(w, `Tc ${t.key} staffed`, t.id, { to: "staffed" });
  await w.h.step("Tc's builders seeded", async () =>
    seedConfig(
      w.db,
      await ticketRows({ now: w.h.clock.now(), ticketId: t.id }),
    ),
  );
  const bound = await w.api.putRoleBinding({
    role: "code_reviewer",
    runner_id: o.schemaRunner,
    executor_id: o.run.executorId,
  });
  if (!bound.ok) throw new Error(bound.error.message);
  return t;
}

/** Steps 3–5 on Tc, its code review on the container. */
async function roundsOnContainer(w: World, o: CtrOptions): Promise<void> {
  const t = await fileTicket(w, o);
  const T = t.id;
  const a = M3C.agents;
  await builderStep(w, "B1c (spike on Tc)", a.spike, T, M3_CALLS.spike);
  // Trivial: B1c's submit_plan opened no plan_review and carried Tc on to planned in the same move
  //, so no approve_plan is left for the operator or the supervisor to take.
  await landedStep(
    w,
    "trivial: submit_plan carried Tc past plan_review (Tc planned)",
    T,
    "planned",
  );
  await operatorStep(w, "start_build (Tc building)", T, { to: "building" });
  const b2 = await builderStep(
    w,
    "B2c (build on Tc)",
    a.build,
    T,
    M3_CALLS.build,
  );
  const r1 = await w.h.step("(3c) round 1: code_review decided", () =>
    gatesUntil(w, T, "Tc's round 1 decided", decided(["code_review"], 1)),
  );
  const code1 = attemptsOf(r1.gates, "code_review")[0];
  await w.h.step(
    "(3c) round 1 on the container: failed on one open major; its reviewer ctr:, reaped",
    async () => {
      const problems = [
        ...gateProblems(
          code1,
          { kind: "code_review", attempt: 1 },
          {
            state: "failed",
            reason: "blocking_findings",
          },
        ),
        ...(code1 === undefined
          ? []
          : [
              ...blockingProblems(code1, { severity: "major", file: "add.js" }),
              ...evidenceProblems(code1, want(w, o, b2, 1)),
            ]),
      ];
      return problems.length > 0 ? verdict(problems) : onContainer(w, o, code1);
    },
  );
  // The decision took the fix round itself: a code failure with its blocker open.
  await supervisorStep(
    w,
    "(3c) the supervisor took request_fix (Tc review_fix)",
    T,
    "review_fix",
  );
  const b3 = await builderStep(w, "B3c (fix on Tc)", a.fix, T, M3_CALLS.fix);
  await w.h.step("(4c) the finding resolved by B3c's run", async () => {
    const d = await w.api.ticket(T);
    if (!d.ok) return d;
    const f = d.value.gates
      .flatMap((g) => g.findings)
      .find((x) => x.id === code1?.findings[0]?.id);
    return verdict(
      resolvedProblems(f, { runId: b3.runId, sessionId: b3.sessionId }),
    );
  });
  const r2 = await w.h.step("(5c) round 2: code_review decided", () =>
    gatesUntil(w, T, "Tc's round 2 decided", decided(["code_review"], 2)),
  );
  const code2 = attemptsOf(r2.gates, "code_review").find(
    (g) => g.attempt === 2,
  );
  await w.h.step(
    "(5c) round 2 on the container: passed with full evidence; its reviewer ctr:, reaped",
    async () => {
      const problems = [
        ...gateProblems(
          code2,
          { kind: "code_review", attempt: 2 },
          {
            state: "passed",
            reason: null,
          },
        ),
        ...(code2 === undefined
          ? []
          : evidenceProblems(code2, want(w, o, b3, 0))),
      ];
      return problems.length > 0 ? verdict(problems) : onContainer(w, o, code2);
    },
  );
  await supervisorStep(
    w,
    "(5c) the supervisor took pass_review (Tc qa_harness)",
    T,
    "qa_harness",
  );
  await w.h.step(
    "(6c) Tc: review_rounds=2, every evidence artifact on disk",
    async () => {
      const d = await w.api.ticket(T);
      if (!d.ok) return d;
      return verdict([
        ...roundsProblems(d.value, 2),
        ...artifactProblems(d.value.gates, existsSync),
      ]);
    },
  );
}

const want = (w: World, o: CtrOptions, run: BuilderRun, findings: number) => ({
  runnerId: o.schemaRunner,
  executorId: o.run.executorId,
  baseSha: w.repo.baseSha,
  headSha: run.head,
  findings,
  parse: "schema" as const,
  singleRunner: false,
});

/** The container run, after setUp (ctrBeforeSupervisor registered and imaged the executor). */
export async function m3Container(w: World, o: CtrOptions): Promise<void> {
  const view = await healthy(w, o);
  await w.h.step(
    "the probe agent and the container reviewer seeded: the reviewer's runner, on the container",
    async () =>
      seedConfig(
        w.db,
        await probeRows({
          now: w.h.clock.now(),
          schemaRunner: o.schemaRunner,
          executorId: o.run.executorId,
        }),
      ),
  );
  // (1c) first: 012's admission.require_certified=1 refuses the reviewer's runner on the container
  // until the pair is certified there, and C1's probe session is that pair.
  await conformance(w, o);
  const sid = await probeSession(w, o);
  await canary(w, o, sid);
  await stopped(w, o, sid);
  await egress(w, o, view);
  await roundsOnContainer(w, o);
}
