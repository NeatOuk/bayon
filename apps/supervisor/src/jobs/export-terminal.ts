// The supervisor-side half of the manifest handshake (design doc §4): the read-only child process
// (export-markdown.ts) never touches the DB; this reads the exporter's own terminal event, reads
// the manifest file it points to, and does the `upsertTicketExport` write per entry -- the DB
// write's only caller (writer discipline: the child never crosses it). Meant to be registered on
// `ingest.onTerminal`, which fires for a live first terminal whether the runner wrote it or the
// supervisor synthesized it (a timeout's own `closeRun`) -- exactly what makes a hung export still
// surface as `export_failed`.
import { readFile } from "node:fs/promises";
import type { Clock } from "@bayon/core";
import { getFirstTerminal, getSession, type Db } from "@bayon/db";
import { upsertTicketExport } from "@bayon/db/supervisor";
import type { Logger } from "pino";
import { ExportManifest } from "./manifest.js";

export interface ExportTerminalNotice {
  readonly sessionId: string;
  readonly runId: string;
  readonly outcome: string;
}

export interface ExportTerminalOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  /** The agent id the exporter's sessions run as (design doc §2): every other session's terminal
   * is ignored at once, since this listener sees the whole fleet's terminals. */
  readonly exporterAgentId: string;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function manifestPathOf(payloadJson: string | null): string | undefined {
  const payload = safeJson(payloadJson ?? "");
  if (typeof payload !== "object" || payload === null) return undefined;
  const path = (payload as Record<string, unknown>)["manifest_path"];
  return typeof path === "string" ? path : undefined;
}

/**
 * Reconciles one exporter session's terminal into `ticket_exports`. Never throws: a missing or
 * malformed manifest, or a write failure, is logged and dropped -- one broken export must never
 * take ingest down with it.
 */
export async function handleExportTerminal(
  o: ExportTerminalOptions,
  notice: ExportTerminalNotice,
): Promise<void> {
  const session = await getSession(o.db, notice.sessionId);
  if (!session.ok || session.value.agent_id !== o.exporterAgentId) return;

  const event = await getFirstTerminal(o.db, notice.runId);
  if (!event.ok || event.value === null) {
    o.log.warn(
      { sessionId: notice.sessionId, runId: notice.runId },
      "export terminal: no terminal event found",
    );
    return;
  }
  const manifestPath = manifestPathOf(event.value.payload_json);
  if (manifestPath === undefined) {
    // A crash before the manifest was written: nothing to reconcile. The session's own state is
    // still visible in the ordinary session view.
    return;
  }

  const text = await readFile(manifestPath, "utf8").catch(() => undefined);
  if (text === undefined) {
    o.log.error(
      { sessionId: notice.sessionId, manifestPath },
      "export terminal: cannot read the manifest",
    );
    return;
  }
  const manifest = ExportManifest.safeParse(safeJson(text));
  if (!manifest.success) {
    o.log.error(
      { sessionId: notice.sessionId, manifestPath },
      "export terminal: manifest failed to parse",
    );
    return;
  }

  const failed = notice.outcome !== "ok";
  for (const entry of manifest.data.entries) {
    const result = await upsertTicketExport(o.db, {
      ticket_id: entry.ticket_id,
      target: entry.target,
      path: entry.path,
      content_hash: entry.content_hash,
      state: failed ? "failed" : "synced",
      last_synced_at: o.clock.now(),
      error: failed ? `export run ended ${notice.outcome}` : null,
    });
    if (!result.ok) {
      o.log.error(
        {
          sessionId: notice.sessionId,
          ticketId: entry.ticket_id,
          error: result.error,
        },
        "export terminal: upsertTicketExport failed",
      );
    }
  }
}
