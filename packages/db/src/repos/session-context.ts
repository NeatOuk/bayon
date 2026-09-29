// A session's context compression totals (spec M12): each run's terminal carries the
// proxy's frames folded as `payload.context` (core ContextTotals, §5.2); the session's are their sum.
// For the session screen's "context saved" line and its warning when a block failed open. Read from
// the stored terminal events rather than kept in more columns: a session has one terminal per run.
import { ContextTotals, ok } from "@bayon/core";
import { z } from "zod";
import { all, qb, read, type Db, type R } from "../connection.js";

/** The session's totals over the runs whose terminal carried them. */
export interface SessionContext {
  /** The ruleset of the first run that reported one (a session's ruleset is pinned). */
  readonly ruleset: string;
  /** Runs whose terminal carried totals. */
  readonly runs: number;
  readonly calls: number;
  readonly blocks: number;
  readonly compressed: number;
  /** Blocks sent whole because compressing them failed (fail open). */
  readonly failed: number;
  readonly chars_in: number;
  readonly chars_out: number;
}

const WithContext = z.looseObject({ context: ContextTotals });

/** A terminal payload's totals; null when it has none, or none that parse. */
function totalsOf(payloadJson: string | null): ContextTotals | null {
  if (payloadJson === null) return null;
  try {
    const parsed = WithContext.safeParse(JSON.parse(payloadJson));
    return parsed.success ? parsed.data.context : null;
  } catch {
    return null; // a payload that is not JSON carries no totals
  }
}

function add(sum: SessionContext | null, t: ContextTotals): SessionContext {
  const base = sum ?? {
    ruleset: t.ruleset,
    runs: 0,
    calls: 0,
    blocks: 0,
    compressed: 0,
    failed: 0,
    chars_in: 0,
    chars_out: 0,
  };
  return {
    ruleset: base.ruleset,
    runs: base.runs + 1,
    calls: base.calls + t.calls,
    blocks: base.blocks + t.blocks,
    compressed: base.compressed + t.compressed,
    failed: base.failed + t.failed,
    chars_in: base.chars_in + t.chars_in,
    chars_out: base.chars_out + t.chars_out,
  };
}

/** The session's context totals; null when no run of it reported any (compression off, or none yet). */
export async function getSessionContext(
  db: Db,
  sessionId: string,
): R<SessionContext | null> {
  const rows = await read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("events")
        .select("payload_json")
        .where("session_id", "=", sessionId)
        .where("kind", "=", "terminal")
        .orderBy("id"),
    ),
  );
  if (!rows.ok) return rows;
  return ok(
    rows.value.reduce<SessionContext | null>((sum, row) => {
      const t = totalsOf(row.payload_json);
      return t === null ? sum : add(sum, t);
    }, null),
  );
}
