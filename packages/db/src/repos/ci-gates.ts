import {
  CI_REQUIRED_ENTRY_MAX,
  CI_REQUIRED_MAX,
  CI_SUBJECT,
  err,
  ok,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  all,
  first,
  qb,
  read,
  readSnapshot,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { GateRow } from "../schema-work.js";
import { deliveryReposIn, type DeliveryRepo } from "./delivery-reads.js";

// What the supervisor's CI sweep reads and writes (spike §1.5, §1.7). Its candidates —
// the running `qa_harness` gates that wait on CI — keyset-paged on (started_at, id); one gate's plan
// (the gate and its project's required checks and wait); and the one thing it writes while a gate
// waits: how far each pull request's checks have got, on the supervisor's own `deliveries` rows.
// The decision itself is `decideGate`'s, the supervisor's one gate writer.

/** Where the previous page ended: the last gate it returned. */
export interface CiGateCursor {
  readonly started_at: number;
  readonly id: string;
}

/** A CI gate the sweep looks at. */
export interface CiGateCandidate extends CiGateCursor {
  readonly ticket_id: string;
}

const Query = z.object({
  limit: z.int().min(1).max(1_000),
  after: z.object({ started_at: z.int(), id: z.string().min(1) }).nullable(),
});

/**
 * Up to `limit` running CI gates after `after`, by started_at then id, **whatever their ticket's
 * status** — as the gate engine's poll takes every running gate (review MEDIUM 2). A ticket blocked
 * or paused mid-gate still has CI running on its pull request and a deadline running on its gate;
 * the decision is recorded, and the machine step waits for the ticket to be back in `qa_harness`
 * (`machineStep` names no step for any other status). A gate is a CI gate by the subject it opened
 * with (`CI_SUBJECT`), never by what its project's mode is now.
 */
export async function listCiGates(
  db: Db,
  q: { readonly limit: number; readonly after: CiGateCursor | null },
): R<CiGateCandidate[]> {
  const parsed = Query.safeParse(q);
  if (!parsed.success) {
    return err(
      failure("validation", `listCiGates: ${z.prettifyError(parsed.error)}`),
    );
  }
  const { limit, after } = parsed.data;
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("gates as g")
        .select(["g.id as id", "g.ticket_id as ticket_id"])
        .select((eb) =>
          eb.fn.coalesce("g.started_at", eb.lit(0)).as("started_at"),
        )
        .where("g.kind", "=", "qa_harness")
        .where("g.state", "=", "running")
        .where("g.subject_kind", "=", CI_SUBJECT)
        .$call((b) =>
          after === null
            ? b
            : b.where((eb) =>
                eb.or([
                  eb(
                    eb.fn.coalesce("g.started_at", eb.lit(0)),
                    ">",
                    after.started_at,
                  ),
                  eb.and([
                    eb(
                      eb.fn.coalesce("g.started_at", eb.lit(0)),
                      "=",
                      after.started_at,
                    ),
                    eb("g.id", ">", after.id),
                  ]),
                ]),
              ),
        )
        .orderBy("started_at")
        .orderBy("g.id")
        .limit(limit),
    ),
  );
}

/** One CI gate, what its project asks of it, and what its ticket has delivered. */
export interface CiGatePlan {
  readonly gate: GateRow;
  readonly ticket_status: string;
  /**
   * `qa_ci_checks_json`, as stored: `name` or `<repo_id>:<name>` entries (core `ciRequirements`
   * reads them against `repo_ids`); empty requires every check each repo reports.
   */
  readonly required: readonly string[];
  /** `qa_ci_timeout_ms` as stored; core `qaCiTimeoutOf` fills the default. */
  readonly timeout_ms: number | null;
  /** The project's repos, by id: what a required entry's prefix may name. */
  readonly repo_ids: readonly string[];
  /**
   * The repos the ticket has a branch in, with what was delivered for each — read whatever the
   * ticket's status, unlike `deliveryPlan`, which answers nothing for a ticket not due.
   */
  readonly repos: readonly DeliveryRepo[];
}

const RequiredChecks = z
  .array(z.string().trim().min(1).max(CI_REQUIRED_ENTRY_MAX))
  .max(CI_REQUIRED_MAX);

/** The stored list, read strictly: a list the API would never have written requires nothing extra. */
function requiredOf(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed = RequiredChecks.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return []; // not JSON: 043's writer never stores one, and "every check" is the safe reading
  }
}

function planIn(ix: Internals, gateId: string): Result<CiGatePlan> {
  const gate = first(
    ix,
    qb.selectFrom("gates").selectAll().where("id", "=", gateId),
  );
  if (gate === undefined) return err(failure("not_found", `gate ${gateId}`));
  const row = first(
    ix,
    qb
      .selectFrom("tickets as t")
      .leftJoin("workspaces as w", "w.id", "t.workspace_id")
      .select([
        "t.status as status",
        "t.workspace_id as workspace_id",
        "w.qa_ci_checks_json as checks",
        "w.qa_ci_timeout_ms as timeout",
      ])
      .where("t.id", "=", gate.ticket_id),
  );
  if (row === undefined) {
    return err(failure("not_found", `ticket ${gate.ticket_id}`));
  }
  const workspaceId = row.workspace_id;
  return ok({
    gate,
    ticket_status: row.status,
    required: requiredOf(row.checks),
    timeout_ms: row.timeout,
    repo_ids:
      workspaceId === null
        ? []
        : all(
            ix,
            qb
              .selectFrom("workspace_repos")
              .select("repo_id")
              .where("workspace_id", "=", workspaceId)
              .orderBy("repo_id"),
          ).map((r) => r.repo_id),
    repos:
      workspaceId === null
        ? []
        : deliveryReposIn(ix, gate.ticket_id, workspaceId),
  });
}

/** One CI gate's plan in one snapshot; an unknown gate or ticket is `not_found`. */
export async function ciGatePlan(db: Db, gateId: string): R<CiGatePlan> {
  const found = await readSnapshot(db, (ix) => planIn(ix, gateId));
  return found.ok ? found.value : found;
}

/** One pull request's read, as the next step counts it. */
export interface CiRead {
  readonly repo_id: string;
  /** The commit whose checks were read: the delivery's `head_sha` at the time. */
  readonly sha: string;
  readonly done: number;
  readonly total: number;
}

export interface CiProgressRecord {
  readonly gate_id: string;
  readonly ticket_id: string;
  readonly reads: readonly CiRead[];
}

const Record_ = z.object({
  gate_id: z.string().min(1),
  ticket_id: z.string().min(1),
  reads: z
    .array(
      z.object({
        repo_id: z.string().min(1),
        sha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
        done: z.int().nonnegative(),
        total: z.int().nonnegative(),
      }),
    )
    .max(64),
});

/**
 * Records how far each pull request's checks have got for `gate_id`: the supervisor's
 * `deliveries` columns, one row per repo, **only where they changed**, so a pass that finds CI
 * where it left it writes nothing. Returns how many rows changed.
 */
export async function recordCiProgress(db: Db, r: CiProgressRecord): R<number> {
  const parsed = Record_.safeParse(r);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `recordCiProgress: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const { gate_id, ticket_id, reads } = parsed.data;
  return write(db, (ix) => {
    let changed = 0;
    for (const x of reads) {
      const updated = all(
        ix,
        qb
          .updateTable("deliveries")
          .set({
            ci_gate_id: gate_id,
            ci_sha: x.sha,
            ci_done: x.done,
            ci_total: x.total,
          })
          .where("ticket_id", "=", ticket_id)
          .where("repo_id", "=", x.repo_id)
          .where((eb) =>
            eb.or([
              eb("ci_gate_id", "is", null),
              eb("ci_gate_id", "!=", gate_id),
              eb("ci_sha", "is", null),
              eb("ci_sha", "!=", x.sha),
              eb("ci_done", "is", null),
              eb("ci_done", "!=", x.done),
              eb("ci_total", "is", null),
              eb("ci_total", "!=", x.total),
            ]),
          )
          .returning("id"),
      );
      changed += updated.length;
    }
    return ok(changed);
  });
}
