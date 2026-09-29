import { AUDIT_PAGE_DEFAULT_LIMIT, AuditPage } from "@bayon/proto";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { getJson } from "@/api/http";

// The Audit page's REST (M4 §12.1): GET /audit, newest first, a page at a time; each
// next page asks for rows before the last one it has.

export interface AuditFilters {
  /** Exact, or a prefix ending in `*`; empty means any. */
  readonly actor: string;
  readonly action: string;
}

/** The query string of one page: the filters that are set, and the cursor when there is one. */
export function auditSearch(f: AuditFilters, before: number | null): string {
  const params = new URLSearchParams({
    limit: String(AUDIT_PAGE_DEFAULT_LIMIT),
  });
  if (before !== null) params.set("before", String(before));
  if (f.actor !== "") params.set("actor", f.actor);
  if (f.action !== "") params.set("action", f.action);
  return params.toString();
}

export const auditQuery = (f: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ["audit", f.actor, f.action],
    queryFn: ({ signal, pageParam }) =>
      getJson(`/audit?${auditSearch(f, pageParam)}`, AuditPage, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
  });
