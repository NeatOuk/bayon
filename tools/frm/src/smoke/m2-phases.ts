import { PULSE_ROLE, hashToolset, newId, ok } from "@bayon/core";
import {
  findLivePulse,
  getAgent,
  getProfile,
  getSession,
  listAuditByActor,
  listRuns,
  listSessionWorktrees,
  listTicketEvents,
  listTicketHandoffs,
  type HandoffRow,
} from "@bayon/db";
import { toolDefinitions, toolsetFor, type TicketView } from "@bayon/proto";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { z } from "zod";
import {
  EXIT_TIMEOUT_MS,
  M2_PULSE_INTERVAL_MS,
  M2_STEP_TIMEOUT_MS,
} from "./budget.js";
import { verdict } from "./harness.js";
import { mcpCallProblems, type ExpectedCall } from "./m1-assertions.js";
import {
  chainProblems,
  completionWakeProblems,
  factFilesProblems,
  handoffRunsProblems,
  nothingToDoProblems,
  operatorWriteProblems,
  packetProblems,
  pulseInitProblems,
  pulseProblems,
  pulseToolsetProblems,
  runNowProblems,
  type PulseSession,
} from "./m2-assertions.js";
import { M2, m2Ticket, packetPath } from "./m2-config.js";
import {
  acceptedBy,
  builderOn,
  fileIn,
  gitStatus,
  handoffFrom,
  holdingNow,
  isLivePulse,
  killRunner,
  pulsesOf,
  ticketIs,
  waitFor,
  worktreeOf,
  type PulseSeen,
  type Worktree,
} from "./m2-reads.js";
import { commandDone, sessionIn, type World } from "./phases.js";
import { stopChild } from "./procs.js";
import { startSupervisor } from "./stack.js";

// `frm smoke --m2` (plan "M2 — Acceptance"): the orchestrator's pulses staff ticket T through
// three hand-offs with no operator in the loop. S1 hits the turn ceiling, S2 asks to hand off,
// S3 dies (SIGKILL, and its resume crashes), S4 blocks T; then a pulse finds nothing to do and two
// run-now calls make one pulse. With a real runner: steps 1–3 and 5, structural checks only.

interface Chain {
  readonly t: TicketView;
  /** When the last operator write (T prioritized) had landed. */
  readonly since: number;
  readonly wt: Worktree;
  readonly real: boolean;
}

const call = (tool: string): ExpectedCall => ({ tool, outcome: "ok" });

/** Stop the supervisor, file and prioritize T (the last operator write), start it: P1 catches up. */
async function readyTicket(
  w: World,
  real: boolean,
): Promise<{ readonly t: TicketView; readonly since: number }> {
  await w.h.step(
    "supervisor stopped (it boots again once T is ready)",
    async () => ok(await stopChild(w.supervisor, w.h.clock, EXIT_TIMEOUT_MS)),
  );
  const filed = await w.h.step("POST /tickets (T, as the operator)", () =>
    w.api.createTicket(m2Ticket(real)),
  );
  const t = await w.h.step(
    `T ${filed.key} prioritized: the last operator write`,
    () =>
      w.api.transitionTicket(filed.id, filed.version, { to: "prioritized" }),
  );
  const since = w.h.clock.now();
  await w.h.step("supervisor up again: its boot catchup is P1", () =>
    startSupervisor({
      home: w.h.home,
      env: w.h.io.env,
      clock: w.h.clock,
      onStart: (c) => w.h.own(c),
      main: w.main.supervisor,
      db: w.db,
      mcpUrl: `http://127.0.0.1:${w.port}/mcp`,
    }),
  );
  return { t, since };
}

/** Step 1: P1 staffs T; S1 and the worktree the whole chain shares. */
async function staffed(w: World, real: boolean): Promise<[Chain, string]> {
  const { t, since } = await readyTicket(w, real);
  const s1 = await w.h.step("P1 staffs T: S1 spawned", () =>
    waitFor(w, "a builder session on T", M2_STEP_TIMEOUT_MS, () =>
      builderOn(w, t.id),
    ),
  );
  w.h.track(s1);
  const wt = await w.h.step(`S1 ${s1} has its worktree`, () =>
    waitFor(w, "S1's worktree", M2_STEP_TIMEOUT_MS, () => worktreeOf(w, s1)),
  );
  return [{ t, since, wt, real }, s1];
}

interface HandOffWant {
  readonly n: number;
  readonly quality: readonly string[];
  readonly reason?: string;
  /** The session's mcp_call events, in order (fixture only). */
  readonly calls?: readonly ExpectedCall[];
}

/** Steps 2–4: the session's hand-off, finalized, its packet file matching its row. */
async function handedOff(
  w: World,
  c: Chain,
  id: string,
  want: HandOffWant,
): Promise<HandoffRow> {
  const path = packetPath(want.n);
  const row = await w.h.step(`S${want.n} handed off: ${path} finalized`, () =>
    waitFor(w, `${id}'s hand-off`, M2_STEP_TIMEOUT_MS, () =>
      handoffFrom(w, c.t.id, id, c.wt.path),
    ),
  );
  await w.h.step(
    `${path}: ${row.quality}, ${row.reason}, its sha256 is the row's`,
    async () =>
      verdict(
        packetProblems(row, fileIn(c.wt.path, path), {
          path,
          quality: want.quality,
          ...(want.reason === undefined ? {} : { reason: want.reason }),
        }),
      ),
  );
  if (!c.real && want.reason !== "session_death") {
    await w.h.step(`S${want.n}: run 1, the handoff run, no run 3`, async () => {
      const runs = await listRuns(w.db, id);
      return runs.ok ? verdict(handoffRunsProblems(id, runs.value)) : runs;
    });
  }
  const calls = want.calls;
  if (calls !== undefined) {
    await w.h.step(`S${want.n}'s MCP calls`, async () => {
      const events = await w.api.events(id);
      return events.ok ? verdict(mcpCallProblems(events.value, calls)) : events;
    });
  }
  await holds(w, c);
  return row;
}

/** A pulse staffs a successor for `row`; it accepts, in the worktree its predecessor left. */
async function successor(
  w: World,
  c: Chain,
  row: HandoffRow,
  n: number,
): Promise<string> {
  const id = await w.h.step(
    `a pulse staffs S${n}, which accepts handoff-${n - 1}`,
    () =>
      waitFor(w, `hand-off ${row.id} accepted`, M2_STEP_TIMEOUT_MS, () =>
        acceptedBy(w, c.t.id, row.id),
      ),
  );
  w.h.track(id);
  await w.h.step(
    `S${n} ${id} took over its predecessor's worktree`,
    async () => {
      const s = await getSession(w.db, id);
      if (!s.ok) return s;
      const wt = await worktreeOf(w, id);
      if (!wt.ok) return wt;
      return verdict([
        ...(s.value.predecessor_session_id === row.from_session_id &&
        s.value.handoff_in_id === row.id
          ? []
          : [
              `${id} does not name ${row.from_session_id ?? "?"} and ${row.id}`,
            ]),
        ...(wt.value?.id === c.wt.id
          ? []
          : [
              `${id} works in ${wt.value?.path ?? "no worktree"}, not ${c.wt.path}`,
            ]),
      ]);
    },
  );
  if (!c.real) await completionWoke(w, row, id, n);
  return id;
}

/**
 * P2–P4: the pulse that staffed Sn woke on handoff-(n−1) going pending, not on the interval, and
 * no earlier than its predecessor's end (S3's degraded packet is announced after its end edge).
 */
async function completionWoke(
  w: World,
  row: HandoffRow,
  id: string,
  n: number,
): Promise<void> {
  const within = M2_PULSE_INTERVAL_MS / 2;
  await w.h.step(
    `P${n} woke on handoff-${n - 1} going pending (completion), within ${within / 1_000} s`,
    async () => {
      const s = await getSession(w.db, id);
      if (!s.ok) return s;
      const from = await getSession(w.db, row.from_session_id ?? "");
      if (!from.ok) return from;
      const pulses = await pulsesOf(w, M2.orch);
      if (!pulses.ok) return pulses;
      const staffing = pulses.value
        .filter(
          (p) => p.state !== "skipped" && p.scheduled_at <= s.value.created_at,
        )
        .at(-1);
      return verdict(
        completionWakeProblems(staffing, from.value.ended_at ?? 0, within),
      );
    },
  );
}

const Allowlist = z.array(z.string());

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Amendment (g): every pulse session carries the MCP tools only. Runner-neutral: its recorded
 * toolset_hash must be the hash of the orchestrator's allowlisted MCP tools (toolsetFor refuses an
 * allowlist naming anything outside the MCP catalogue), it holds no worktree, and its session_init
 * shows the runner exposed nothing else (the profile alone proved nothing).
 */
async function pulseTools(
  w: World,
  pulses: readonly PulseSeen[],
): Promise<void> {
  await w.h.step(
    "pulse sessions: orchestrators on the MCP toolset alone (toolset_hash, session_init), no worktree",
    async () => {
      const agent = await getAgent(w.db, M2.orch);
      if (!agent.ok) return agent;
      const profile = await getProfile(w.db, agent.value.profile_id ?? "");
      if (!profile.ok) return profile;
      const allowlist = Allowlist.safeParse(
        parsedJson(profile.value.tool_allowlist_json),
      );
      if (!allowlist.success)
        return verdict(["the orchestrator's tool allowlist is not a list"]);
      const tools = toolsetFor(PULSE_ROLE, allowlist.data);
      if (!tools.ok) return tools;
      const mcpHash = await hashToolset(toolDefinitions(tools.value));
      const allowed = tools.value.map((t) => t.wire);
      const sessions: PulseSession[] = [];
      const exposed: string[] = [];
      for (const p of pulses) {
        if (p.session_id === null) continue;
        const s = await getSession(w.db, p.session_id);
        if (!s.ok) return s;
        const worktrees = await listSessionWorktrees(w.db, p.session_id);
        if (!worktrees.ok) return worktrees;
        sessions.push({
          id: s.value.id,
          role: s.value.role,
          toolset_hash: s.value.toolset_hash,
          worktrees: worktrees.value.length,
        });
        const events = await w.api.events(p.session_id);
        if (!events.ok) return events;
        exposed.push(...pulseInitProblems(s.value.id, events.value, allowed));
      }
      return verdict([...pulseToolsetProblems(sessions, mcpHash), ...exposed]);
    },
  );
}

const holds = (w: World, c: Chain): Promise<void> =>
  w.h.step(
    "T: exactly one of a live owner, a pending hand-off, a closed status",
    () => holdingNow(w, c.t.id),
  );

/** Step 4: S3 holds T at its gate, is SIGKILLed, its resume crashes: a degraded packet. */
async function killed(w: World, c: Chain, s3: string): Promise<HandoffRow> {
  await w.h.step("S3 holds T at its gate", async () => {
    const running = await sessionIn(w, s3, "running");
    return running.ok ? holdingNow(w, c.t.id) : running;
  });
  await w.h.step(`S3 ${s3}: its runner SIGKILLed`, () => killRunner(w, s3));
  const row = await handedOff(w, c, s3, {
    n: 3,
    quality: ["degraded"],
    reason: "session_death",
    calls: [call("handoff_accept")],
  });
  await w.h.step(
    "handoff-3's files are exactly what git status shows",
    async () => {
      const status = gitStatus(c.wt.path);
      return status.ok
        ? verdict(factFilesProblems(row.facts_json, status.value))
        : status;
    },
  );
  return row;
}

/** Step 5: S4 accepts the degraded hand-off and blocks T. */
async function blocked(w: World, c: Chain, s4: string): Promise<number> {
  await w.h.step("S4 blocks T", () =>
    waitFor(w, "T blocked", M2_STEP_TIMEOUT_MS, () =>
      ticketIs(w, c.t.id, "blocked"),
    ),
  );
  const at = w.h.clock.now();
  await w.h.step(
    "S4's run ended: accept, ticket_get, ticket_update",
    async () => {
      const idle = await sessionIn(w, s4, "idle");
      if (!idle.ok) return idle;
      const events = await w.api.events(s4);
      return events.ok
        ? verdict(
            mcpCallProblems(events.value, [
              call("handoff_accept"),
              call("ticket_get"),
              call("ticket_update"),
            ]),
          )
        : events;
    },
  );
  await holds(w, c);
  return at;
}

/** Nothing any operator wrote since T was prioritized. */
async function noOperator(w: World, c: Chain): Promise<void> {
  await w.h.step("no operator write since T was prioritized", async () => {
    const audit = await listAuditByActor(w.db, "operator");
    if (!audit.ok) return audit;
    const events = await listTicketEvents(w.db, { since: 0, limit: 1000 });
    if (!events.ok) return events;
    return verdict(
      operatorWriteProblems(audit.value, events.value.rows, c.since),
    );
  });
}

/** The chain as the rows record it: sessions linked to hand-offs, each packet file intact. */
async function chainIntact(
  w: World,
  c: Chain,
  sessions: readonly string[],
  trailingPending = false,
): Promise<void> {
  const n = sessions.length - 1 + (trailingPending ? 1 : 0);
  await w.h.step(
    `handoff_count = ${n}; the chain ${sessions.map((_, i) => `S${i + 1}`).join(" → ")}`,
    async () => {
      const rows = await Promise.all(
        sessions.map((id) => getSession(w.db, id)),
      );
      const handoffs = await listTicketHandoffs(w.db, c.t.id);
      if (!handoffs.ok) return handoffs;
      const found = rows.flatMap((r) => (r.ok ? [r.value] : []));
      if (found.length !== rows.length)
        return verdict(["a chain session is gone"]);
      const files = handoffs.value.flatMap((h, i) =>
        packetProblems(h, fileIn(c.wt.path, packetPath(i + 1)), {
          path: packetPath(i + 1),
          quality: ["full", "degraded"],
        }),
      );
      return verdict([
        ...chainProblems(found, handoffs.value, { trailingPending }),
        ...files,
      ]);
    },
  );
}

/** The orchestrator's pulses so far, checked; their sessions are tracked for teardown. */
async function pulsesOk(w: World, c: Chain): Promise<PulseSeen[]> {
  return w.h.step(
    `pulses: done or skipped, P1 a catchup, packs ≤ ${M2.packCapTokens} tokens, spend carries the pulse`,
    async () => {
      const pulses = await pulsesOf(w, M2.orch);
      if (!pulses.ok) return pulses;
      for (const p of pulses.value)
        if (p.session_id !== null) w.h.track(p.session_id);
      const checked = verdict(
        pulseProblems(pulses.value, {
          capTokens: M2.packCapTokens,
          unreportedOk: c.real,
          inFlightOk: c.real,
        }),
      );
      return checked.ok ? ok(pulses.value) : checked;
    },
  );
}

/** Pulses in lease order: a pulse id is a ULID minted when it is leased (leasePulse). */
const byLease = (pulses: readonly PulseSeen[]): PulseSeen[] =>
  pulses.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * Step 6: the first pulse leased after the block finds nothing to do: skipped at $0. Chosen by
 * lease order, not scheduled_at, which is when a wake was planned and can precede the block.
 */
async function quiet(w: World, blockedAt: number): Promise<PulseSeen> {
  const mark = newId(blockedAt).slice(0, 10); // a ULID's time prefix: 10 characters
  const p5 = await w.h.step("P5, the first pulse leased after the block", () =>
    waitFor(
      w,
      "the first pulse leased after the block, settled",
      M2_STEP_TIMEOUT_MS,
      async () => {
        const pulses = await pulsesOf(w, M2.orch);
        if (!pulses.ok) return pulses;
        const first = byLease(pulses.value).find(
          (p) => p.id.slice(0, 10) > mark,
        );
        return ok(
          first !== undefined && !isLivePulse(first.state) ? first : undefined,
        );
      },
    ),
  );
  await w.h.step("P5 skipped(nothing_to_do) at $0", async () =>
    verdict(nothingToDoProblems(p5)),
  );
  return p5;
}

/** Step 6: two concurrent run-now calls make one pulse, which settles and releases its lease. */
async function runNowTwice(w: World, after: PulseSeen): Promise<void> {
  const accepted = await w.h.step(
    "two concurrent POST /pulses/run-now",
    async () => {
      const key = (i: number) =>
        `smoke:m2:run-now:${i}:${newId(w.h.clock.now())}`;
      const [a, b] = await Promise.all([
        w.api.pulseRunNow(M2.orch, key(1)),
        w.api.pulseRunNow(M2.orch, key(2)),
      ]);
      if (!a.ok) return a;
      return b.ok ? ok([a.value, b.value]) : b;
    },
  );
  const results: unknown[] = [];
  for (const a of accepted) {
    const done = await w.h.step(`pulse.run ${a.command_id} done`, () =>
      commandDone(w, a.command_id),
    );
    results.push(done.result);
  }
  const created = await w.h.step("the run-now pulse settled", () =>
    waitFor(w, "the manual pulse settled", M2_STEP_TIMEOUT_MS, async () => {
      const pulses = await pulsesOf(w, M2.orch);
      if (!pulses.ok) return pulses;
      const newer = byLease(pulses.value).filter((p) => p.id > after.id);
      return ok(
        newer.length > 0 && newer.every((p) => !isLivePulse(p.state))
          ? newer
          : undefined,
      );
    }),
  );
  await w.h.step(
    "they made one pulse, done; every lease released",
    async () => {
      const live = await findLivePulse(w.db, M2.orch);
      if (!live.ok) return live;
      for (const p of created)
        if (p.session_id !== null) w.h.track(p.session_id);
      return verdict([
        ...runNowProblems(results, created),
        ...created
          .filter((p) => p.state !== "done")
          .map((p) => `the run-now pulse ${p.id} is ${p.state}`),
        ...(live.value === null
          ? []
          : [`pulse ${live.value.id} still holds its lease`]),
      ]);
    },
  );
}

/** The real check's last step: S3 blocks T, or hands off in turn; either way T holds. */
async function realEnd(
  w: World,
  c: Chain,
  sessions: readonly string[],
): Promise<void> {
  const s3 = sessions[2] ?? "";
  await holds(w, c);
  const outcome = await w.h.step("S3 blocks T, or hands off in turn", () =>
    waitFor(w, "S3 blocking T or handing off", M2_STEP_TIMEOUT_MS, async () => {
      const t = await ticketIs(w, c.t.id, "blocked");
      if (!t.ok || t.value !== undefined) return t;
      const row = await handoffFrom(w, c.t.id, s3, c.wt.path);
      return row.ok
        ? ok(row.value === undefined ? undefined : "handed off")
        : row;
    }),
  );
  w.h.note(`real check: S3 ${outcome}`);
  await holds(w, c);
  await noOperator(w, c);
  // S3 either blocked T (the chain ends at S3) or handed off in turn (its hand-off still waits).
  await chainIntact(w, c, sessions.slice(0, 3), outcome !== "blocked");
  await pulseTools(w, await pulsesOk(w, c));
}

/** The M2 acceptance test, after setUp (m2Config): steps 1–6 on the fixture runner. */
export async function m2(w: World): Promise<void> {
  const real = w.runnerId !== FIXTURE_RUNNER_ID;
  const [c, s1] = await staffed(w, real);
  const any = ["full", "degraded"];
  const row1 = await handedOff(w, c, s1, {
    n: 1,
    quality: real ? any : ["full"],
    ...(real
      ? {}
      : {
          reason: "turn_ceiling",
          calls: [call("handoff_accept"), call("handoff_write")],
        }),
  });
  const s2 = await successor(w, c, row1, 2);
  const row2 = await handedOff(w, c, s2, {
    n: 2,
    quality: real ? any : ["full"],
    ...(real
      ? {}
      : {
          reason: "agent_request",
          calls: [
            call("handoff_accept"),
            call("handoff_request"),
            call("handoff_write"),
          ],
        }),
  });
  if (!real) {
    await w.h.step(
      `S2 found S1's ${M2.notes} in the inherited worktree`,
      async () =>
        verdict(
          (fileIn(c.wt.path, M2.notes) ?? "").includes("S1 took the ticket") &&
            (fileIn(c.wt.path, M2.notes) ?? "").includes("S2 continued")
            ? []
            : [`${M2.notes} lacks S1's or S2's line`],
        ),
    );
  }
  const s3 = await successor(w, c, row2, 3);
  if (real) return realEnd(w, c, [s1, s2, s3]);
  const row3 = await killed(w, c, s3);
  const s4 = await successor(w, c, row3, 4);
  const blockedAt = await blocked(w, c, s4);
  const p5 = await quiet(w, blockedAt);
  await noOperator(w, c);
  await chainIntact(w, c, [s1, s2, s3, s4]);
  await pulseTools(w, await pulsesOk(w, c));
  await runNowTwice(w, p5);
}
