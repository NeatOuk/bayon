// The claimer handler for `export.run` (contract 5/6): settles fast, like every
// handler (claimer.ts's contract) -- it only decides whether to reuse the exporter's live session
// or ask the lifecycle to spawn one, never does the export itself.
import { ok, type JsonValue, type Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import { z } from "zod";
import type { CommandHandler } from "../commands/claimer.js";
import { spawnExportIfIdle } from "./export-guard.js";

export interface ExportCommandOptions {
  readonly db: Db;
  /** The exporter's `agents.id` (design doc §2). */
  readonly agentId: string;
  /** Starts a fresh exporter session and resolves to its id; called only when none is live. */
  readonly spawn: () => Promise<Result<string>>;
}

const EmptyPayload = z.object({});

/** `export.run`'s payload is always `{}`; the interesting decision is entirely in `spawnExportIfIdle`. */
export function exportRunHandler(
  o: ExportCommandOptions,
): CommandHandler<z.infer<typeof EmptyPayload>> {
  return {
    type: "export.run",
    payload: EmptyPayload,
    // The single-exporter guard and the session id's idempotency: a re-export overwrites.
    idempotent: true,
    handle: async (): Promise<Result<JsonValue>> => {
      const result = await spawnExportIfIdle({
        db: o.db,
        agentId: o.agentId,
        spawn: o.spawn,
      });
      return result.ok ? ok({ session_id: result.value }) : result;
    },
  };
}
