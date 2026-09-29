import { existsSync } from "node:fs";
import { GATE_SETTING_KEYS, err, ok, type JsonValue } from "@bayon/core";
import { getSettings } from "@bayon/db";
import { seedConfig } from "@bayon/db/operator";
import type {
  CreateTicketRequest,
  GateView,
  PutRoleBinding,
  TicketView,
} from "@bayon/proto";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { SMOKE } from "./config.js";
import { refuse, verdict } from "./harness.js";
import {
  artifactProblems,
  attemptsOf,
  blockingProblems,
  evidenceProblems,
  gateProblems,
  resolvedProblems,
  retryProblems,
  roundsProblems,
  type EvidenceWant,
} from "./m3-assertions.js";
import { M3, M3_CALLS, M3_TICKETS, m3Rows } from "./m3-config.js";
import {
  M3_PARITY,
  M3_PARITY_CALLS,
  M3_PARITY_TICKET,
  createParityRepos,
  parityAgentRows,
  parityGateProblems,
  parityPlaceRows,
  type ParityRepos,
} from "./m3-parity.js";
import { certify } from "./certify.js";
import {
  builderStep,
  decided,
  gatesUntil,
  operatorStep,
  supervisorStep,
  type BuilderRun,
} from "./m3-reads.js";
import type { World } from "./phases.js";

// `frm smoke --m3` (plan "M3 — Acceptance"): the builder is the fixture runner, the
// reviewer the runner whose stand-in CLI declares outputSchema. (1) conformance certifies both;
// on non-trivial ticket T, (2) plan_review passes with evidence, (3) round 1 fails on one major,
// (4) the fix resolves it naming its run, (5) round 2 passes, (6) two rounds and every artifact on
// disk, (7) QA only by the operator's override; (8) a hanging review times out into attempt 2 on T2;
// (9) a same-runner review is flagged on T3; (10) with `gates.parity_check` turned on, trivial T4's
// multi-repo round opens a real parity_check and the parity job decides it with evidence
//. The machine steps are the supervisor's: each decision that settles one —
// approve_plan in (2), request_fix in (3), pass_review in (5) and (10) — takes it in the same
// transaction, and the smoke checks the move is there and is the supervisor's, never makes it.

export interface M3Options {
  /** The runner whose stand-in declares outputSchema: plan_review and code_review's reviewer. */
  readonly schemaRunner: string;
  /**
   * Where rounds 1 and 2 are reviewed. Only the smoke's local executor runs today; a container
   * executor (FRM_CONTAINER=1 --executor <id>) waits for an earlier change and is refused before setUp.
   */
  readonly reviewExecutor: string;
}

interface Tickets {
  readonly main: TicketView;
  readonly hang: TicketView;
  readonly same: TicketView;
  /** Step 10's multi-repo ticket: the one whose round opens parity_check. */
  readonly parity: TicketView;
}

interface M3World extends M3Options {
  readonly w: World;
  readonly t: Tickets;
  /** The two origin repos of step 10's multi workspace. */
  readonly repos: ParityRepos;
}

const PASSED = { state: "passed", reason: null } as const;

/** Files one non-trivial ticket and staffs it (prioritize, staff) as the operator. */
async function fileOne(
  w: World,
  name: string,
  body: CreateTicketRequest,
  /** T4 is trivial on purpose: no plan_review opens, so step 10 pays for one gate fewer. */
  o: { readonly nonTrivial?: boolean } = {},
): Promise<TicketView> {
  const nonTrivial = o.nonTrivial ?? true;
  const want = nonTrivial ? "non-trivial" : "trivial";
  const filed = await w.h.step(`POST /tickets (${name}): ${want}`, async () => {
    const t = await w.api.createTicket(body);
    if (!t.ok) return t;
    return t.value.non_trivial === nonTrivial
      ? ok(t.value)
      : err(refuse(`${name} is ${t.value.complexity_tier}, not ${want}`));
  });
  const prioritized = await operatorStep(
    w,
    `${name} ${filed.key} prioritized`,
    filed.id,
    { to: "prioritized" },
  );
  return operatorStep(w, `${name} ${prioritized.key} staffed`, filed.id, {
    to: "staffed",
  });
}

async function setUpM3(w: World, o: M3Options): Promise<M3World> {
  const main = await fileOne(w, "T", M3_TICKETS.main);
  const hang = await fileOne(w, "T2", M3_TICKETS.hang);
  const same = await fileOne(w, "T3", M3_TICKETS.same);
  // Step 10's place, before its ticket: a ticket names the workspace it belongs to.
  const repos = await w.h.step(
    "(10) two more origin repos and the multi workspace they sit in",
    async () => {
      const made = createParityRepos(w.h.home);
      if (!made.ok) return made;
      const seeded = await seedConfig(w.db, parityPlaceRows(made.value));
      return seeded.ok ? ok(made.value) : seeded;
    },
  );
  const parity = await fileOne(w, "T4", M3_PARITY_TICKET, {
    nonTrivial: false,
  });
  await w.h.step(
    "builders, reviewers and the parity checker seeded: fixture builders scripted on T, T2, T3, T4",
    async () => {
      const now = w.h.clock.now();
      const rows = await m3Rows({
        now,
        tickets: { main: main.id, hang: hang.id, same: same.id },
        schemaRunner: o.schemaRunner,
        home: w.h.home,
      });
      const t4 = await parityAgentRows({ now, ticketId: parity.id });
      return seedConfig(w.db, {
        ...rows,
        profiles: [...(rows.profiles ?? []), ...(t4.profiles ?? [])],
        agents: [...(rows.agents ?? []), ...(t4.agents ?? [])],
      });
    },
  );
  return { ...o, w, t: { main, hang, same, parity }, repos };
}

const bind = (m: M3World, name: string, body: PutRoleBinding): Promise<void> =>
  m.w.h.step(name, async () => {
    const put = await m.w.api.putRoleBinding(body);
    return put.ok ? ok(undefined) : put;
  });

/** What a pass or a fail with evidence must show, for the gate reviewed on `run`'s HEAD. */
const want = (
  m: M3World,
  run: BuilderRun,
  o: Pick<EvidenceWant, "runnerId" | "executorId" | "findings" | "parse"> &
    Partial<Pick<EvidenceWant, "singleRunner">>,
): EvidenceWant => ({
  baseSha: m.w.repo.baseSha,
  headSha: run.head,
  singleRunner: false,
  ...o,
});

/** The one attempt `attempt` of `kind`. */
const attempt = (
  gates: readonly GateView[],
  kind: string,
  n: number,
): GateView | undefined => attemptsOf(gates, kind).find((g) => g.attempt === n);

/** Step 2: the spike's submit_plan opens plan_review; it passes with full evidence. */
async function planReviewed(m: M3World): Promise<void> {
  const T = m.t.main.id;
  const b1 = await builderStep(
    m.w,
    "B1 (spike on T)",
    M3.agents.spike,
    T,
    M3_CALLS.spike,
  );
  const d = await m.w.h.step(
    "(2) submit_plan opened plan_review, now decided",
    () =>
      gatesUntil(
        m.w,
        T,
        "T's plan_review decided",
        decided(["plan_review"], 1),
      ),
  );
  await m.w.h.step(
    "(2) plan_review passed: every evidence field, exit_code 0, the schema reviewer",
    async () => {
      const g = attempt(d.gates, "plan_review", 1);
      const at = { kind: "plan_review", attempt: 1 };
      const state = gateProblems(g, at, PASSED);
      return verdict(
        g === undefined || state.length > 0
          ? state
          : [
              ...(attemptsOf(d.gates, "plan_review").length === 1
                ? []
                : ["submit_plan opened more than one plan_review"]),
              ...evidenceProblems(
                g,
                want(m, b1, {
                  runnerId: m.schemaRunner,
                  executorId: SMOKE.executor,
                  findings: 0,
                  parse: "schema",
                }),
              ),
            ],
      );
    },
  );
  await supervisorStep(
    m.w,
    "(2) the supervisor took approve_plan with the decision: T planned",
    T,
    "planned",
  );
  await operatorStep(m.w, "start_build: T building", T, { to: "building" });
}

/** Step 3: request_review opens round 1; code_review fails on one major; the supervisor asks for a fix. */
async function roundOne(m: M3World): Promise<string> {
  const T = m.t.main.id;
  const b2 = await builderStep(
    m.w,
    "B2 (build on T)",
    M3.agents.build,
    T,
    M3_CALLS.build,
  );
  const d = await m.w.h.step(
    "(3) request_review opened round 1: code_review and ce_review decided",
    () =>
      gatesUntil(
        m.w,
        T,
        "round 1 decided",
        decided(["code_review", "ce_review"], 1),
      ),
  );
  const code = attempt(d.gates, "code_review", 1);
  await m.w.h.step(
    `(3) round 1: code_review failed on one open major in ${M3.codePath}; ce_review passed`,
    async () => {
      const ce = attempt(d.gates, "ce_review", 1);
      const failed = { state: "failed", reason: "blocking_findings" } as const;
      return verdict([
        ...gateProblems(code, { kind: "code_review", attempt: 1 }, failed),
        ...(code === undefined
          ? []
          : [
              ...blockingProblems(code, {
                severity: "major",
                file: M3.codePath,
              }),
              ...evidenceProblems(
                code,
                want(m, b2, {
                  runnerId: m.schemaRunner,
                  executorId: m.reviewExecutor,
                  findings: 1,
                  parse: "schema",
                }),
              ),
            ]),
        ...gateProblems(ce, { kind: "ce_review", attempt: 1 }, PASSED),
        ...(ce === undefined
          ? []
          : evidenceProblems(
              ce,
              want(m, b2, {
                runnerId: FIXTURE_RUNNER_ID,
                executorId: SMOKE.executor,
                findings: 0,
                parse: "heuristic",
              }),
            )),
      ]);
    },
  );
  await supervisorStep(
    m.w,
    "(3) the supervisor took request_fix with the round's last decision: T review_fix",
    T,
    "review_fix",
  );
  const findingId = code?.findings[0]?.id;
  if (findingId === undefined)
    throw new Error("unreachable: round 1's finding was checked above");
  return findingId;
}

/** Step 4: the fixing builder resolves the finding, linking its run. */
async function fixed(m: M3World, findingId: string): Promise<BuilderRun> {
  const T = m.t.main.id;
  const b3 = await builderStep(
    m.w,
    "B3 (fix on T)",
    M3.agents.fix,
    T,
    M3_CALLS.fix,
  );
  await m.w.h.step(
    "(4) finding_resolve linked the fixing run: resolved by B3's run 1, with its note",
    async () => {
      const d = await m.w.api.ticket(T);
      if (!d.ok) return d;
      const f = d.value.gates
        .flatMap((g) => g.findings)
        .find((x) => x.id === findingId);
      return verdict(
        resolvedProblems(f, { runId: b3.runId, sessionId: b3.sessionId }),
      );
    },
  );
  return b3;
}

/** Step 5: resubmit opens round 2 at the fix's head; both pass; the supervisor passes the round. */
async function roundTwo(m: M3World, b3: BuilderRun): Promise<void> {
  const T = m.t.main.id;
  const d = await m.w.h.step(
    "(5) resubmit opened round 2: code_review and ce_review decided",
    () =>
      gatesUntil(
        m.w,
        T,
        "round 2 decided",
        decided(["code_review", "ce_review"], 2),
      ),
  );
  await m.w.h.step(
    "(5) round 2 passed: code_review and ce_review, full evidence on the fix's head",
    async () => {
      const code = attempt(d.gates, "code_review", 2);
      const ce = attempt(d.gates, "ce_review", 2);
      return verdict([
        ...gateProblems(code, { kind: "code_review", attempt: 2 }, PASSED),
        ...(code === undefined
          ? []
          : evidenceProblems(
              code,
              want(m, b3, {
                runnerId: m.schemaRunner,
                executorId: m.reviewExecutor,
                findings: 0,
                parse: "schema",
              }),
            )),
        ...gateProblems(ce, { kind: "ce_review", attempt: 2 }, PASSED),
        ...(ce === undefined
          ? []
          : evidenceProblems(
              ce,
              want(m, b3, {
                runnerId: FIXTURE_RUNNER_ID,
                executorId: SMOKE.executor,
                findings: 0,
                parse: "heuristic",
              }),
            )),
      ]);
    },
  );
  await supervisorStep(
    m.w,
    "(5) the supervisor took pass_review with the round's last decision: T qa_harness",
    T,
    "qa_harness",
  );
}

/** Step 6: the round count from the view, and every artifact any evidence names, on disk. */
const roundsAndArtifacts = (m: M3World): Promise<void> =>
  m.w.h.step(
    "(6) GET /tickets/T: review_rounds=2, and every evidence artifact path exists",
    async () => {
      const d = await m.w.api.ticket(m.t.main.id);
      if (!d.ok) return d;
      return verdict([
        ...roundsProblems(d.value, 2),
        ...artifactProblems(d.value.gates, existsSync),
      ]);
    },
  );

/** Step 7: a worker's pass_harness is refused; the operator's, with a note, is the override. */
async function qaOverride(m: M3World): Promise<void> {
  const T = m.t.main.id;
  // B4 moves no status: its pass_harness is refused, so no phase ended and it holds its ticket
  // until the operator stops it (the §7.4 degraded path, unchanged by).
  await builderStep(
    m.w,
    "B4 (tries pass_harness on T)",
    M3.agents.qa,
    T,
    M3_CALLS.qa,
    { handsOff: false },
  );
  await m.w.h.step(
    "(7) the worker's pass_harness was refused: T still qa_harness",
    async () => {
      const d = await m.w.api.ticket(T);
      if (!d.ok) return d;
      return verdict(
        d.value.ticket.status === "qa_harness"
          ? []
          : [`T is ${d.value.ticket.status}, not qa_harness`],
      );
    },
  );
  await operatorStep(
    m.w,
    "(7) the operator's override with a note: T qa_human",
    T,
    {
      to: "qa_human",
      override_note: M3.qaOverride,
    },
  );
}

const WALL_CLOCK = GATE_SETTING_KEYS.wall_clock_ms;

/** Sets gates.wall_clock_ms, as the operator tunes a setting. */
const setWallClock = (m: M3World, value: JsonValue) =>
  seedConfig(m.w.db, { settings: { [WALL_CLOCK]: value } });

/** Step 8: T2's plan reviewer hangs; the gate times out, and decideGate retries it as attempt 2. */
async function hangRetried(m: M3World): Promise<void> {
  const T2 = m.t.hang.id;
  const before = await m.w.h.step(
    `(8) ${WALL_CLOCK} set to ${M3.hangWallClockMs} ms for the hanging review`,
    async () => {
      const read = await getSettings(m.w.db, [WALL_CLOCK]);
      if (!read.ok) return read;
      const value = read.value.get(WALL_CLOCK);
      if (value === undefined)
        return err(refuse(`${WALL_CLOCK} is not set (migration 007 seeds it)`));
      const set = await setWallClock(m, M3.hangWallClockMs);
      return set.ok ? ok(value as JsonValue) : set;
    },
  );
  try {
    await bind(
      m,
      "(8) plan_reviewer bound to a fixture review that never answers",
      {
        role: "plan_reviewer",
        runner_id: FIXTURE_RUNNER_ID,
        profile_id: M3.reviewHangProfile,
      },
    );
    await builderStep(
      m.w,
      "B5 (spike on T2)",
      M3.agents.spikeHang,
      T2,
      M3_CALLS.spike,
    );
    const d = await m.w.h.step(
      "(8) T2's plan_review: attempts 1 and 2 decided",
      () =>
        gatesUntil(m.w, T2, "T2's retry decided", decided(["plan_review"], 2)),
    );
    await m.w.h.step(
      "(8) attempt 1 failed{timeout}; the retry is attempt 2 (it timed out too; no third)",
      async () => verdict(retryProblems(attemptsOf(d.gates, "plan_review"))),
    );
  } finally {
    await m.w.h.step(`${WALL_CLOCK} put back`, () => setWallClock(m, before));
  }
}

/** Step 9: T3's plan reviewer is bound to the builder's own runner: the evidence flags it. */
async function sameRunner(m: M3World): Promise<void> {
  const T3 = m.t.same.id;
  await bind(m, "(9) plan_reviewer bound to the builder's own runner", {
    role: "plan_reviewer",
    runner_id: FIXTURE_RUNNER_ID,
  });
  const b6 = await builderStep(
    m.w,
    "B6 (spike on T3)",
    M3.agents.spikeSame,
    T3,
    M3_CALLS.spike,
  );
  const d = await m.w.h.step("(9) T3's plan_review decided", () =>
    gatesUntil(
      m.w,
      T3,
      "T3's plan_review decided",
      decided(["plan_review"], 1),
    ),
  );
  await m.w.h.step(
    "(9) same-runner review: passed, flags.single_runner_review in its evidence",
    async () => {
      const g = attempt(d.gates, "plan_review", 1);
      const state = gateProblems(
        g,
        { kind: "plan_review", attempt: 1 },
        PASSED,
      );
      return verdict(
        g === undefined || state.length > 0
          ? state
          : evidenceProblems(
              g,
              want(m, b6, {
                runnerId: FIXTURE_RUNNER_ID,
                executorId: SMOKE.executor,
                findings: 0,
                parse: "heuristic",
                singleRunner: true,
              }),
            ),
      );
    },
  );
}

/**
 * Step 10: the first smoke to open, run and decide a real `parity_check`.
 *
 * The operator turns `gates.parity_check` on — T, T2 and T3 are on a `single` workspace, so
 * `isMultiRepo` stays false for them and nothing of steps 2–9 moves. T4's workspace is `multi`, so
 * `request_review` opens `parity_check` beside `code_review`, the parity job reads the two mirrors
 * and the database and decides it, and `pass_review` — which asks for this round's parity gate
 * (023) — carries the ticket on.
 */
async function parityRound(m: M3World, repos: ParityRepos): Promise<void> {
  const T4 = m.t.parity.id;
  await m.w.h.step("(10) operator turns gates.parity_check on", async () => {
    const put = await seedConfig(m.w.db, {
      settings: { [GATE_SETTING_KEYS.parity_check]: true },
    });
    return put.ok ? ok(undefined) : put;
  });
  const b7 = await builderStep(
    m.w,
    "B7 (spike on T4, multi-repo)",
    M3_PARITY.agent,
    T4,
    M3_PARITY_CALLS,
    {
      workspaceId: M3_PARITY.workspace,
      relPath: M3_PARITY.primary.relPath,
    },
  );
  await operatorStep(m.w, "(10) start_build: T4 building", T4, {
    to: "building",
  });
  await operatorStep(m.w, "(10) request_review: T4 in code_review", T4, {
    to: "code_review",
  });
  const d = await m.w.h.step(
    "(10) the round opened parity_check beside code_review, both decided",
    () =>
      gatesUntil(
        m.w,
        T4,
        "T4's round decided",
        decided(["code_review", "parity_check"], 1),
      ),
  );
  await m.w.h.step(
    "(10) parity_check passed: the parity job on local, heuristic, no findings",
    async () =>
      verdict(
        parityGateProblems(attempt(d.gates, "parity_check", 1), {
          baseSha: repos.primary.baseSha,
          headSha: b7.head,
        }),
      ),
  );
  // This assertion used to read the other way round, deliberately. H3 refuses a
  // repo-less **diff** gate on a ticket whose worktrees span repos; `ticket_repos` — the table that
  // would say which repos to open a gate for — had no writer anywhere, so it was empty on every
  // ticket and a real multi-repo ticket's code_review ended `reviewer_error` and could never leave
  // the status. (It is still why `parity_check` has a `workspace` subject rather than a diff: one
  // gate for the whole workspace, no repo to pin.) Now the `code_review` transition records the
  // repos the ticket touches — T4's builder committed in the primary only, so that is the one
  // recorded — and the gate is pinned to it and reviewed like any other.
  await m.w.h.step(
    "(10) code_review is pinned to the repo T4 touched, and passes with evidence",
    async () => {
      const g = attempt(d.gates, "code_review", 1);
      const state = gateProblems(
        g,
        { kind: "code_review", attempt: 1 },
        PASSED,
      );
      if (g === undefined || state.length > 0) return verdict(state);
      return verdict([
        ...(g.repo_id === M3_PARITY.primary.repo
          ? []
          : [
              `code_review is pinned to ${g.repo_id ?? "no repo"}, not ${M3_PARITY.primary.repo}`,
            ]),
        ...evidenceProblems(g, {
          runnerId: m.schemaRunner,
          executorId: m.reviewExecutor,
          baseSha: repos.primary.baseSha,
          headSha: b7.head,
          findings: 0,
          parse: "schema",
          singleRunner: false,
        }),
      ]);
    },
  );
  // The dep repo has no commits of its own, so no gate opened for it: §3.1 asks for evidence from
  // every repo the ticket *touched*, and paying a reviewer to read an empty range is not that.
  await m.w.h.step("(10) the untouched dep repo got no gate of its own", () =>
    Promise.resolve(
      verdict(
        d.gates
          .filter((g) => g.repo_id === M3_PARITY.dep.repo)
          .map(
            (g) =>
              `${g.kind} attempt ${String(g.attempt)} opened on the untouched dep repo`,
          ),
      ),
    ),
  );
  // And so pass_review carries T4 on — the move this whole round exists to reach, and the one that
  // was refused `gate_not_passed` for as long as the gate could not be pinned. The supervisor took
  // it with the round's last decision.
  await supervisorStep(
    m.w,
    "(10) the supervisor took pass_review: T4 reaches qa_harness",
    T4,
    "qa_harness",
  );
}

/** The M3 acceptance test, after setUp: steps 1–10. */
export async function m3(w: World, o: M3Options): Promise<void> {
  const m = await setUpM3(w, o);
  // The fixture builder was certified after setUp, as in every smoke (run.ts).
  await certify(w, o.schemaRunner, "(1) ");
  await bind(m, "plan_reviewer bound to the schema reviewer", {
    role: "plan_reviewer",
    runner_id: o.schemaRunner,
  });
  await bind(
    m,
    `code_reviewer bound to the schema reviewer on ${o.reviewExecutor}`,
    {
      role: "code_reviewer",
      runner_id: o.schemaRunner,
      executor_id: o.reviewExecutor,
    },
  );
  await planReviewed(m);
  const findingId = await roundOne(m);
  const b3 = await fixed(m, findingId);
  await roundTwo(m, b3);
  await roundsAndArtifacts(m);
  await qaOverride(m);
  await hangRetried(m);
  await sameRunner(m);
  await parityRound(m, m.repos);
}
