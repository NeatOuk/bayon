import { PULSE_WINDOW_MS, err, newId, ok, type Result } from "@bayon/core";
import { sql, type Updateable } from "kysely";
import { z } from "zod";
import {
  all,
  first,
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { casMiss, failure } from "../errors.js";
import type { PulseRow, PulseState, PulsesTable } from "../schema-pulse.js";
import { LIVE_PULSE_STATES } from "./pulses.js";

// pulses' writers (§9.5: the supervisor's). The single-flight lease is
// pulses_lease_idx, and the rate cap is checked in the lease's own transaction, so no caller (the
// planner, a manual run-now, a second connection) can exceed either.

/** What a pulse cost: the spend rows its session wrote, which carry its id (§8.9). */
const SPENT = sql<number>`(SELECT coalesce(sum(spend.cost_usd), 0) FROM spend WHERE spend.pulse_id = pulses.id)`;

const NewLease = z.object({
  agent_id: z.string().min(1),
  trigger: z.enum(["cron", "completion", "manual", "catchup"]),
  /** When the wake was due. */
  scheduled_at: z.int().nonnegative(),
  /** pulse.lease_ttl_ms: the lease never renews (amendment d). */
  lease_ttl_ms: z.int().positive(),
  /** agents.pulse_max_per_hour: the hard cap, manual included (review H2). */
  max_per_hour: z.int().positive(),
});
export type NewLease = z.input<typeof NewLease>;

export type LeaseOutcome =
  | { readonly kind: "leased"; readonly pulse: PulseRow }
  /** The agent already has a live pulse: it is returned, and nothing is written. */
  | { readonly kind: "coalesced"; readonly pulse: PulseRow }
  /**
   * The window is full: a skipped(rate_capped) row, written when the trigger is manual or the
   * window has none yet (`created`), else the window's newest. `firstInWindow`: the window had
   * no such row before, so this is the one warning of the window.
   */
  | {
      readonly kind: "capped";
      readonly pulse: PulseRow;
      readonly created: boolean;
      readonly firstInWindow: boolean;
    };

/**
 * Takes the agent's single-flight lease, in one transaction: a live pulse coalesces; a full
 * trailing-hour window (pulses that ran, by scheduled_at) caps; else a `leased` row with a token
 * and `lease_expires_at = now + lease_ttl_ms`.
 */
export async function leasePulse(db: Db, input: NewLease): R<LeaseOutcome> {
  const parsed = NewLease.safeParse(input);
  if (!parsed.success) {
    return err(
      failure("validation", `bad lease: ${z.prettifyError(parsed.error)}`),
    );
  }
  const l = parsed.data;
  return write(db, (ix): Result<LeaseOutcome> => {
    const now = ix.clock.now();
    const live = first(
      ix,
      qb
        .selectFrom("pulses")
        .selectAll()
        .where("agent_id", "=", l.agent_id)
        .where("state", "in", LIVE_PULSE_STATES),
    );
    if (live !== undefined) return ok({ kind: "coalesced", pulse: live });
    const since = now - PULSE_WINDOW_MS;
    const ran =
      first(
        ix,
        qb
          .selectFrom("pulses")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("agent_id", "=", l.agent_id)
          .where("state", "<>", "skipped")
          .where("scheduled_at", ">", since),
      )?.n ?? 0;
    if (ran >= l.max_per_hour) return capped(ix, l, now, since);
    const pulse = returningOne(
      ix,
      qb
        .insertInto("pulses")
        .values({
          id: newId(now),
          agent_id: l.agent_id,
          trigger: l.trigger,
          scheduled_at: l.scheduled_at,
          lease_token: newId(now),
          lease_expires_at: now + l.lease_ttl_ms,
          state: "leased",
        })
        .returningAll(),
    );
    return pulse.ok ? ok({ kind: "leased", pulse: pulse.value }) : pulse;
  });
}

function capped(
  ix: Internals,
  l: z.infer<typeof NewLease>,
  now: number,
  since: number,
): Result<LeaseOutcome> {
  const existing = first(
    ix,
    qb
      .selectFrom("pulses")
      .selectAll()
      .where("agent_id", "=", l.agent_id)
      .where("state", "=", "skipped")
      .where("skip_reason", "=", "rate_capped")
      .where("scheduled_at", ">", since)
      .orderBy("scheduled_at", "desc")
      .orderBy("id", "desc"),
  );
  if (existing !== undefined && l.trigger !== "manual") {
    return ok({
      kind: "capped",
      pulse: existing,
      created: false,
      firstInWindow: false,
    });
  }
  const row = returningOne(
    ix,
    qb
      .insertInto("pulses")
      .values({
        id: newId(now),
        agent_id: l.agent_id,
        trigger: l.trigger,
        scheduled_at: l.scheduled_at,
        state: "skipped",
        skip_reason: "rate_capped",
        cost_usd: 0,
        ended_at: now,
      })
      .returningAll(),
  );
  return row.ok
    ? ok({
        kind: "capped",
        pulse: row.value,
        created: true,
        firstInWindow: existing === undefined,
      })
    : row;
}

/** The columns a pulse's life fills in. Its identity, trigger and lease are written once. */
export type PulsePatch = Partial<
  Pick<
    Updateable<PulsesTable>,
    | "state"
    | "skip_reason"
    | "session_id"
    | "run_id"
    | "context_pack_path"
    | "context_tokens"
    | "summary_md"
    | "actions_json"
    | "cost_usd"
    | "started_at"
    | "ended_at"
  >
>;

/** Which pulse a patch may touch: its id, the states it may be in, and optionally its session. */
export interface PulseCas {
  readonly id: string;
  readonly from: readonly PulseState[];
  readonly session_id?: string;
}

/** A compare-and-set on the pulse's state (and session, when given); a miss is `conflict`. */
export async function updatePulse(
  db: Db,
  cas: PulseCas,
  patch: PulsePatch,
): R<PulseRow> {
  if (Object.keys(patch).length === 0) {
    return err(failure("validation", "an empty pulse patch"));
  }
  return write(db, (ix): Result<PulseRow> => {
    const row = first(
      ix,
      qb
        .updateTable("pulses")
        .set(patch)
        .where("id", "=", cas.id)
        .where("state", "in", cas.from)
        .$if(cas.session_id !== undefined, (b) =>
          b.where("session_id", "=", cas.session_id ?? ""),
        )
        .returningAll(),
    );
    return row === undefined ? miss(ix, cas) : ok(row);
  });
}

function miss(ix: Internals, cas: PulseCas): Result<never> {
  const current = first(
    ix,
    qb
      .selectFrom("pulses")
      .select(["state", "session_id"])
      .where("id", "=", cas.id),
  );
  if (current !== undefined && cas.from.includes(current.state)) {
    return err(
      failure(
        "conflict",
        `pulse ${cas.id} belongs to session ${current.session_id ?? "none"}, not ${cas.session_id ?? "none"}`,
      ),
    );
  }
  return casMiss(`pulse ${cas.id}`, current, cas.from);
}

/** A `pulse.report` payload as the pulse stores it (its full shape is proto's PulseReportPayload). */
const Report = z.object({
  summary_md: z.string().min(1),
  actions: z.array(z.string()),
});
export type PulseReport = z.infer<typeof Report>;

const reportPatch = (r: PulseReport) => ({
  summary_md: r.summary_md,
  actions_json: JSON.stringify(r.actions),
});

/**
 * The `pulse.report` handler's write (review H1): the report lands only while the pulse is running
 * under that session; the latest report wins. A pulse already settled or expired is not an error
 * (`applied: false`): settlePulse has applied that report itself, or it came too late.
 */
export async function applyPulseReport(
  db: Db,
  r: PulseReport & { readonly pulse_id: string; readonly session_id: string },
): R<{ readonly applied: boolean; readonly pulse: PulseRow }> {
  const report = Report.safeParse(r);
  if (!report.success) {
    return err(
      failure(
        "validation",
        `bad pulse report: ${z.prettifyError(report.error)}`,
      ),
    );
  }
  return write(db, (ix): Result<{ applied: boolean; pulse: PulseRow }> => {
    const row = first(
      ix,
      qb
        .updateTable("pulses")
        .set(reportPatch(report.data))
        .where("id", "=", r.pulse_id)
        .where("session_id", "=", r.session_id)
        .where("state", "=", "running")
        .returningAll(),
    );
    if (row !== undefined) return ok({ applied: true, pulse: row });
    const current = first(
      ix,
      qb.selectFrom("pulses").selectAll().where("id", "=", r.pulse_id),
    );
    if (current === undefined) {
      return err(failure("not_found", `pulse ${r.pulse_id} does not exist`));
    }
    return current.session_id === r.session_id
      ? ok({ applied: false, pulse: current })
      : err(
          failure(
            "conflict",
            `pulse ${r.pulse_id} is not session ${r.session_id}'s`,
          ),
        );
  });
}

/** Run 1's facts, which a settled pulse records. */
export interface PulseRunFacts {
  readonly run_id: string;
  readonly context_pack_path: string;
  readonly context_tokens: number | null;
}

export interface SettlePulse {
  readonly id: string;
  /** Null when no run ever opened. */
  readonly run: PulseRunFacts | null;
  /** The skip_reason when the pulse fails for want of a report, e.g. `unreported`. */
  readonly fail_reason: string;
}

/**
 * Ends a live pulse in one transaction (review H1): the newest `pulse.report` command still
 * pending or claimed for it is applied first, so nothing waits on the claimer. A summary makes it
 * `done`, else `failed(fail_reason)`; its cost is the sum of its spend rows.
 */
export async function settlePulse(db: Db, s: SettlePulse): R<PulseRow> {
  return write(db, (ix): Result<PulseRow> => {
    const pulse = first(
      ix,
      qb.selectFrom("pulses").selectAll().where("id", "=", s.id),
    );
    if (pulse === undefined || !isLive(pulse.state)) {
      return casMiss(`pulse ${s.id}`, pulse, LIVE_PULSE_STATES);
    }
    const report = pendingReport(ix, s.id);
    const summary = report?.summary_md ?? pulse.summary_md;
    return returningOne(
      ix,
      qb
        .updateTable("pulses")
        .set({
          ...(report === undefined ? {} : reportPatch(report)),
          state: summary === null ? "failed" : "done",
          skip_reason: summary === null ? s.fail_reason : null,
          cost_usd: SPENT,
          ended_at: ix.clock.now(),
          ...(s.run === null ? {} : s.run),
        })
        .where("id", "=", s.id)
        .where("state", "in", LIVE_PULSE_STATES)
        .returningAll(),
    );
  });
}

const isLive = (state: PulseState): boolean =>
  (LIVE_PULSE_STATES as readonly PulseState[]).includes(state);

/** The newest pulse.report command not yet handled for `pulseId`, if its payload parses. */
function pendingReport(
  ix: Internals,
  pulseId: string,
): PulseReport | undefined {
  const row = first(
    ix,
    qb
      .selectFrom("commands")
      .select("payload_json")
      .where("type", "=", "pulse.report")
      .where("state", "in", ["pending", "claimed"])
      .where(
        sql<string>`json_extract(payload_json, '$.pulse_id')`,
        "=",
        pulseId,
      )
      .orderBy("ts", "desc")
      .orderBy("id", "desc"),
  );
  if (row === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    return undefined; // the claimer fails it as a validation error
  }
  const parsed = Report.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/** A live pulse whose lease has run out, and the session to stop. */
export interface ExpiredPulse {
  readonly id: string;
  readonly agent_id: string;
  readonly session_id: string | null;
}

/**
 * §9.6 step 5: every live pulse past `lease_expires_at` becomes `expired`, its cost summed from
 * spend so far (resumPulseCosts completes it once the session has gone). No renewal (amendment d).
 */
export function releaseExpiredPulseLeases(db: Db): R<ExpiredPulse[]> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    return ok(
      all(
        ix,
        qb
          .updateTable("pulses")
          .set({ state: "expired", ended_at: now, cost_usd: SPENT })
          .where("state", "in", LIVE_PULSE_STATES)
          .where("lease_expires_at", "<", now)
          .returning(["id", "agent_id", "session_id"]),
      ),
    );
  });
}

/**
 * Re-sums the cost of every pulse with a session that ended at or after `since` (review M4): an
 * expiry can sum before its session's last spend row commits. Idempotent. Returns how many.
 */
export function resumPulseCosts(db: Db, since: number): R<number> {
  return write(db, (ix) =>
    ok(
      all(
        ix,
        qb
          .updateTable("pulses")
          .set({ cost_usd: SPENT })
          .where("state", "in", ["done", "failed", "expired"])
          .where("session_id", "is not", null)
          .where("ended_at", ">=", since)
          .returning("id"),
      ).length,
    ),
  );
}
