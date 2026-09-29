// The Jira mirror's reads, from @bayon/db: which of a project's mirrored tickets are
// still the mirror's to move, and the project's last sync (its newest `jira.sync` audit row).
import { jiraFingerprintPrefix, type TicketStatus } from "@bayon/core";
import { all, first, qb, read, type Db, type R } from "../connection.js";
import { JIRA_ORIGIN, UNSTARTED, startedByBayon } from "./jira-mirror.js";

export interface MirroredOpen {
  readonly fingerprint: string;
  /** The Jira issue's numeric id: the fingerprint's last part. */
  readonly issueId: string;
  readonly status: Extract<TicketStatus, (typeof UNSTARTED)[number]>;
}

/**
 * Project `workspaceId`'s tickets mirrored from `host` that are still `backlog` or `prioritized`
 * and that Bayon never began (the loop guard): the ones a sync may yet park.
 */
export function mirroredOpenFingerprints(
  db: Db,
  workspaceId: string,
  host: string,
): R<MirroredOpen[]> {
  const prefix = jiraFingerprintPrefix(host);
  return read(db, (ix) => {
    const rows = all(
      ix,
      qb
        .selectFrom("tickets")
        .select(["id", "origin_fingerprint", "status"])
        .where("workspace_id", "=", workspaceId)
        .where("origin", "=", JIRA_ORIGIN)
        .where("status", "in", UNSTARTED)
        // A prefix match that no `%` or `_` in the host can widen.
        .where((eb) =>
          eb(
            eb.fn<number>("instr", [
              eb.ref("origin_fingerprint"),
              eb.val(prefix),
            ]),
            "=",
            1,
          ),
        )
        .orderBy("num"),
    );
    const begun = startedByBayon(
      ix,
      rows.map((r) => r.id),
    );
    return rows.flatMap((row) => {
      const fingerprint = row.origin_fingerprint ?? "";
      const status = UNSTARTED.find((s) => s === row.status);
      return status === undefined || begun.has(row.id)
        ? []
        : [{ fingerprint, issueId: fingerprint.slice(prefix.length), status }];
    });
  });
}

export interface JiraSyncRow {
  readonly ts: number;
  /** The audit payload as stored: the API parses it (proto JiraSyncRecord). */
  readonly payload_json: string | null;
}

/** Project `workspaceId`'s newest `jira.sync` audit row, or null before its first sync. */
export function lastJiraSync(
  db: Db,
  workspaceId: string,
): R<JiraSyncRow | null> {
  return read(
    db,
    (ix) =>
      first(
        ix,
        qb
          .selectFrom("audit_log")
          .select(["ts", "payload_json"])
          .where("workspace_id", "=", workspaceId)
          .where("action", "=", "jira.sync")
          .orderBy("ts", "desc")
          .orderBy("id", "desc")
          .limit(1),
      ) ?? null,
  );
}
