// GET /audit (§12.1, M4): audit_log newest first, a page at a time, filtered by actor and
// action. Reads only: the API and the supervisor's named writers append it (§9.5).
import { all, qb, read, type Db, type R } from "../connection.js";
import type { AuditRow } from "./attribution.js";

export interface AuditPageQuery {
  /** Only rows older than this id (the previous page's last). */
  readonly before?: number;
  readonly limit: number;
  /** Exact, or a prefix when it ends in `*` (e.g. `session:*`). */
  readonly actor?: string;
  /** Exact, or a prefix when it ends in `*` (e.g. `mcp.*`). */
  readonly action?: string;
}

export interface AuditPage {
  readonly rows: AuditRow[];
  readonly hasMore: boolean;
}

/** A filter's match: exact, or the text before a trailing `*` as a prefix. */
export function auditMatch(
  filter: string,
): { readonly prefix: string } | { readonly exact: string } {
  return filter.endsWith("*")
    ? { prefix: filter.slice(0, -1) }
    : { exact: filter };
}

export function listAuditPage(db: Db, q: AuditPageQuery): R<AuditPage> {
  return read(db, (ix) => {
    let query = qb.selectFrom("audit_log").selectAll();
    if (q.before !== undefined) query = query.where("id", "<", q.before);
    for (const [column, filter] of [
      ["actor", q.actor],
      ["action", q.action],
    ] as const) {
      if (filter === undefined) continue;
      const match = auditMatch(filter);
      // instr(column, prefix) = 1: starts with the prefix, byte for byte (LIKE folds ASCII case).
      query =
        "exact" in match
          ? query.where(column, "=", match.exact)
          : query.where(
              (eb) =>
                eb.fn<number>("instr", [eb.ref(column), eb.val(match.prefix)]),
              "=",
              1,
            );
    }
    const rows = all(ix, query.orderBy("id", "desc").limit(q.limit + 1));
    return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
  });
}
