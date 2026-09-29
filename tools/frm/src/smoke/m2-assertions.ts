import { createHash } from "node:crypto";
import { HandoffFacts, UNHELD_STATUSES, holdsTicket } from "@bayon/core";
import { ENDED_STATES } from "@bayon/db";
import { z } from "zod";

// The M2 smoke's pure checks (plan "M2 — Acceptance"). Each returns what is wrong, as sentences;
// an empty list passes. Inputs are the few columns each check reads.

const list = (texts: readonly string[]): string =>
  texts.length === 0 ? "none" : texts.join(", ");
const ended = (state: string): boolean =>
  (ENDED_STATES as readonly string[]).includes(state);

export interface HoldingTicket {
  readonly id: string;
  readonly status: string;
  readonly owner_session_id: string | null;
}
export interface HoldingSession {
  readonly id: string;
  readonly state: string;
  readonly role: string;
  readonly ticket_id: string | null;
  readonly handoff_in_id: string | null;
}

/**
 * §13.1 / plan rule 3: the ticket has exactly one of a live session holding it (core holdsTicket),
 * a pending hand-off (the one predicate: `pending` is what listPendingHandoffs returns), or a
 * terminal or blocked status.
 */
export function holdingProblems(
  ticket: HoldingTicket,
  sessions: readonly HoldingSession[],
  pending: readonly string[],
): string[] {
  const holders = sessions
    .filter((s) => !ended(s.state) && holdsTicket(s, ticket))
    .map((s) => s.id);
  const closed = UNHELD_STATUSES.includes(ticket.status);
  const held = [
    ...(holders.length > 0 ? [`live owner ${list(holders)}`] : []),
    ...(pending.length > 0 ? [`pending hand-off ${list(pending)}`] : []),
    ...(closed ? [`status ${ticket.status}`] : []),
  ];
  return [
    ...(held.length === 1
      ? []
      : [
          `ticket ${ticket.id} has ${held.length === 0 ? "none" : held.join(" and ")} of: a live owner, a pending hand-off, a terminal or blocked status`,
        ]),
    ...(holders.length > 1 ? [`${holders.length} live owners`] : []),
    ...(pending.length > 1 ? [`${pending.length} pending hand-offs`] : []),
  ];
}

export interface ChainSession {
  readonly id: string;
  readonly predecessor_session_id: string | null;
  readonly handoff_in_id: string | null;
}
export interface ChainHandoff {
  readonly id: string;
  readonly from_session_id: string | null;
  readonly to_session_id: string | null;
  readonly accepted_at: number | null;
}

/** S1 → … → Sn: each hand-off written by one session and accepted by the next, which names both.
 * With `trailingPending`, the last session has handed off in turn and its hand-off still waits. */
export function chainProblems(
  sessions: readonly ChainSession[],
  handoffs: readonly ChainHandoff[],
  opts: { readonly trailingPending?: boolean } = {},
): string[] {
  const first = sessions[0];
  if (first === undefined) return ["no session worked the ticket"];
  const expected = sessions.length - 1 + (opts.trailingPending ? 1 : 0);
  const count =
    handoffs.length === expected
      ? []
      : [
          `${handoffs.length} hand-offs for ${sessions.length} sessions, expected ${expected}`,
        ];
  const last = sessions[sessions.length - 1];
  const tail = handoffs[sessions.length - 1];
  const trailing =
    !opts.trailingPending || last === undefined || tail === undefined
      ? []
      : [
          ...(tail.from_session_id === last.id
            ? []
            : [
                `the last hand-off is from ${tail.from_session_id ?? "nobody"}, not ${last.id}`,
              ]),
          ...(tail.to_session_id === null && tail.accepted_at === null
            ? []
            : [`the last hand-off ${tail.id} should still be pending`]),
        ];
  const root =
    first.predecessor_session_id === null && first.handoff_in_id === null
      ? []
      : [`the first session ${first.id} names a predecessor`];
  const links = handoffs.flatMap((h, i) => {
    const from = sessions[i];
    const to = sessions[i + 1];
    if (from === undefined || to === undefined) return [];
    return [
      ...(h.from_session_id === from.id
        ? []
        : [
            `hand-off ${i + 1} is from ${h.from_session_id ?? "nobody"}, not ${from.id}`,
          ]),
      ...(h.to_session_id === to.id && h.accepted_at !== null
        ? []
        : [`hand-off ${i + 1} was not accepted by ${to.id}`]),
      ...(to.predecessor_session_id === from.id && to.handoff_in_id === h.id
        ? []
        : [`${to.id} does not take over ${from.id}'s hand-off ${h.id}`]),
    ];
  });
  return [...count, ...root, ...links, ...trailing];
}

export interface PacketRow {
  readonly id: string;
  readonly reason: string;
  readonly quality: string;
  readonly packet_path: string;
  readonly packet_hash: string;
}

/** A finalized packet: its path, quality and reason, and the file's sha256 equal to the row's. */
export function packetProblems(
  row: PacketRow,
  file: string | undefined,
  want: {
    readonly path: string;
    readonly quality: readonly string[];
    readonly reason?: string;
  },
): string[] {
  const hash =
    file === undefined
      ? undefined
      : createHash("sha256").update(file).digest("hex");
  return [
    ...(row.packet_path === want.path
      ? []
      : [
          `hand-off ${row.id}'s packet is ${row.packet_path}, not ${want.path}`,
        ]),
    ...(want.quality.includes(row.quality)
      ? []
      : [
          `hand-off ${row.id} is ${row.quality}, expected ${want.quality.join(" or ")}`,
        ]),
    ...(want.reason === undefined || row.reason === want.reason
      ? []
      : [
          `hand-off ${row.id}'s reason is ${row.reason}, expected ${want.reason}`,
        ]),
    ...(file === undefined
      ? [`no packet file ${want.path} in the worktree`]
      : hash === row.packet_hash
        ? []
        : [
            `${want.path}'s sha256 ${hash} is not the row's ${row.packet_hash}`,
          ]),
  ];
}

/** `git status --porcelain=v1 -z`: `XY path\0` (a rename adds `orig\0`), as "code path" lines. */
export function porcelainFiles(out: string): string[] {
  const files: string[] = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i += 1) {
    const entry = tokens[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.push(`${code.trim()} ${entry.slice(3)}`);
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
  }
  return files.toSorted();
}

function parsedFacts(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** The packet's uncommitted files (its facts, from git) equal what `git status` shows now. */
export function factFilesProblems(
  factsJson: string,
  porcelain: string,
): string[] {
  const facts = HandoffFacts.safeParse(parsedFacts(factsJson));
  if (!facts.success) return ["the hand-off's facts_json is not HandoffFacts"];
  const inFacts = facts.data.repos
    .flatMap((r) => r.files)
    .filter((f) => f.code !== "committed")
    .map((f) => `${f.code} ${f.path}`)
    .toSorted();
  const inGit = porcelainFiles(porcelain);
  return inFacts.join("\n") === inGit.join("\n")
    ? []
    : [`the packet lists ${list(inFacts)}; git status shows ${list(inGit)}`];
}

/** A session's runs: run 1, then the hand-off run, and no run 3. */
export function handoffRunsProblems(
  sessionId: string,
  runs: readonly { readonly seq: number; readonly trigger: string }[],
): string[] {
  const seen = runs.map((r) => `${r.seq}:${r.trigger}`);
  return runs.length === 2 && runs[1]?.trigger === "handoff"
    ? []
    : [
        `session ${sessionId} ran ${list(seen)}; expected run 1 then a handoff run, and no run 3`,
      ];
}

export interface PulseFacts {
  readonly id: string;
  readonly trigger: string;
  readonly state: string;
  readonly skip_reason: string | null;
  readonly session_id: string | null;
  readonly context_tokens: number | null;
  readonly cost_usd: number | null;
  /** The pulse_id on its run 1's spend row; undefined when it has none. */
  readonly spend_pulse_id?: string | null;
}

const pulseText = (p: PulseFacts): string =>
  `${p.id} ${p.trigger} ${p.state}${p.skip_reason === null ? "" : `(${p.skip_reason})`}`;

/**
 * The orchestrator's pulses, oldest first: none live (every lease released), each done or
 * skipped (a real model may also leave one failed(unreported)), the first that ran a catchup;
 * a done one has a session, its pack within the cap and its spend carrying the pulse; a skipped
 * one cost $0 and spawned nothing.
 */
export function pulseProblems(
  all: readonly PulseFacts[],
  o: {
    readonly capTokens: number;
    readonly unreportedOk: boolean;
    /** The real check ends while the fleet still works: judge settled pulses, allow one in flight. */
    readonly inFlightOk?: boolean;
  },
): string[] {
  const live = (p: PulseFacts) => p.state === "leased" || p.state === "running";
  const inFlight = all.filter(live);
  const pulses = o.inFlightOk ? all.filter((p) => !live(p)) : all;
  const flight =
    o.inFlightOk && inFlight.length > 1
      ? [`${inFlight.length} pulses in flight at once`]
      : [];
  const settled = (p: PulseFacts) =>
    p.state === "done" ||
    p.state === "skipped" ||
    (o.unreportedOk && p.state === "failed" && p.skip_reason === "unreported");
  const ran = pulses.filter((p) => p.state !== "skipped");
  const first = ran[0];
  return [
    ...flight,
    ...pulses
      .filter((p) => !settled(p))
      .map((p) => `pulse ${pulseText(p)} is not done or skipped`),
    ...(first === undefined
      ? ["no pulse ran"]
      : first.trigger === "catchup"
        ? []
        : [
            `the first pulse that ran is ${pulseText(first)}, not the boot catchup`,
          ]),
    ...ran.flatMap((p) => [
      ...(p.session_id === null ? [`pulse ${p.id} ran no session`] : []),
      ...(p.context_tokens !== null && p.context_tokens <= o.capTokens
        ? []
        : [
            `pulse ${p.id}'s pack is ${p.context_tokens ?? "unknown"} tokens, cap ${o.capTokens}`,
          ]),
      ...(p.spend_pulse_id === p.id
        ? []
        : [
            `pulse ${p.id}'s spend carries pulse ${p.spend_pulse_id ?? "none"}`,
          ]),
    ]),
    ...pulses
      .filter((p) => p.state === "skipped")
      .flatMap((p) =>
        p.cost_usd === 0 && p.session_id === null
          ? []
          : [
              `skipped pulse ${p.id} cost $${p.cost_usd ?? "?"} or ran a session`,
            ],
      ),
  ];
}

/** P5: nothing to do, so skipped at $0 with no session. */
export function nothingToDoProblems(p: PulseFacts | undefined): string[] {
  if (p === undefined) return ["no pulse came after the ticket was blocked"];
  return p.state === "skipped" &&
    p.skip_reason === "nothing_to_do" &&
    p.cost_usd === 0 &&
    p.session_id === null
    ? []
    : [
        `the pulse after the block is ${pulseText(p)} at $${p.cost_usd ?? "?"}, expected skipped(nothing_to_do) at $0`,
      ];
}

/** No operator write lands after `since`: not in audit_log, not as a ticket event. */
export function operatorWriteProblems(
  audit: readonly {
    readonly ts: number;
    readonly actor: string;
    readonly action: string;
  }[],
  ticketEvents: readonly {
    readonly ts: number;
    readonly actor_kind: string;
    readonly kind: string;
  }[],
  since: number,
): string[] {
  const writes = [
    ...audit
      .filter((a) => a.actor === "operator" && a.ts > since)
      .map((a) => `audit ${a.action}`),
    ...ticketEvents
      .filter((e) => e.actor_kind === "operator" && e.ts > since)
      .map((e) => `ticket event ${e.kind}`),
  ];
  return writes.length === 0
    ? []
    : [`operator writes after the ticket was prioritized: ${list(writes)}`];
}

/** What a done `pulse.run` command returns (pulse-commands.ts). */
export const RunNowResult = z.object({
  pulse_id: z.string().nullable(),
  outcome: z.string(),
});

/** Two concurrent run-now calls: both name one pulse, and it is the one new (manual) pulse. */
export function runNowProblems(
  results: readonly unknown[],
  created: readonly Pick<PulseFacts, "id" | "trigger">[],
): string[] {
  const parsed = results.map((r) => RunNowResult.safeParse(r));
  if (parsed.some((p) => !p.success))
    return [
      `a pulse.run result is not {pulse_id, outcome}: ${JSON.stringify(results)}`,
    ];
  const ok = parsed.flatMap((p) => (p.success ? [p.data] : []));
  const ids = new Set(ok.map((r) => r.pulse_id));
  const only = created[0];
  return [
    ...(ids.size === 1 && !ids.has(null)
      ? []
      : [`the run-now calls named pulses ${list([...ids].map(String))}`]),
    ...(ok.every((r) => r.outcome === "running" || r.outcome === "coalesced")
      ? []
      : [`run-now outcomes: ${list(ok.map((r) => r.outcome))}`]),
    ...(created.length === 1 && only?.trigger === "manual" && ids.has(only.id)
      ? []
      : [
          `${created.length} new pulses (${list(created.map((p) => `${p.id} ${p.trigger}`))}), expected the one manual pulse`,
        ]),
  ];
}

/**
 * P2, P3 (§9.7; design §3 (b)): the pulse that staffed a successor woke because the
 * hand-off went pending (a completion), within `withinMs` of it, not on the cron interval.
 */
export function completionWakeProblems(
  p: (PulseFacts & { readonly scheduled_at: number }) | undefined,
  pendingAt: number,
  withinMs: number,
): string[] {
  if (p === undefined) return ["no pulse ran before the successor was spawned"];
  const after = p.scheduled_at - pendingAt;
  return [
    ...(p.trigger === "completion"
      ? []
      : [
          `pulse ${pulseText(p)} woke on ${p.trigger}, not on the pending hand-off`,
        ]),
    ...(after >= 0 && after < withinMs
      ? []
      : [
          `pulse ${p.id} woke ${after} ms after the hand-off went pending, not within ${withinMs} ms`,
        ]),
  ];
}

export interface PulseSession {
  readonly id: string;
  readonly role: string;
  readonly toolset_hash: string | null;
  /** The worktrees it holds: none, since a pulse works no repo. */
  readonly worktrees: number;
}

/** session_init's runner-neutral tool lists. */
const InitTools = z.looseObject({
  mcp_tools: z.array(z.string()),
  builtin_tools: z.array(z.string()),
});

/**
 * Rule 4 from what the runner actually exposed, not what the profile asked for: a pulse
 * session's session_init lists none of the runner's own tools and at least one MCP tool, every one
 * in the orchestrator's toolset (`allowed`, wire names). A session that never ran exposed nothing.
 */
export function pulseInitProblems(
  sessionId: string,
  events: readonly { readonly kind: string; readonly payload: unknown }[],
  allowed: readonly string[],
): string[] {
  if (events.length === 0) return [];
  const init = events.find((e) => e.kind === "session_init");
  if (init === undefined)
    return [`pulse session ${sessionId} has no session_init`];
  const tools = InitTools.safeParse(init.payload);
  if (!tools.success) {
    return [
      `pulse session ${sessionId}'s session_init does not list mcp_tools and builtin_tools`,
    ];
  }
  const { mcp_tools: mcp, builtin_tools: builtin } = tools.data;
  const stray = mcp.filter((t) => !allowed.includes(t));
  return [
    ...(builtin.length === 0
      ? []
      : [
          `pulse session ${sessionId} exposes the runner's own tools: ${list(builtin)}`,
        ]),
    ...(stray.length === 0
      ? []
      : [
          `pulse session ${sessionId} exposes MCP tools outside its toolset: ${list(stray)}`,
        ]),
    ...(mcp.length > 0
      ? []
      : [`pulse session ${sessionId} exposes no MCP tool`]),
  ];
}

/**
 * M2 amendment (g), rule 4: a pulse session is an orchestrator whose tools are exactly the MCP
 * toolset (its toolset_hash is the orchestrator's allowlisted MCP tools', `mcpHash`) and which
 * holds no worktree: no shell or file tools, and no files to use them on.
 */
export function pulseToolsetProblems(
  sessions: readonly PulseSession[],
  mcpHash: string,
): string[] {
  if (sessions.length === 0) return ["no pulse session to check"];
  return sessions.flatMap((s) => [
    ...(s.role === "orchestrator"
      ? []
      : [`pulse session ${s.id} is a ${s.role}`]),
    ...(s.toolset_hash === mcpHash
      ? []
      : [
          `pulse session ${s.id}'s toolset_hash ${s.toolset_hash ?? "none"} is not the MCP toolset's ${mcpHash}`,
        ]),
    ...(s.worktrees === 0
      ? []
      : [`pulse session ${s.id} holds ${s.worktrees} worktree(s)`]),
  ]);
}
