// The exporter's child process: the `script` runner's argv points here. Read-only on the DB
// (design review point 1): it never calls `upsertTicketExport` itself, and its `terminal` payload
// carries only a manifest path -- `export-terminal.ts`, running in the supervisor's own process,
// does the one DB write. Speaks the same tiny stdin/stdout protocol every script job speaks
// (`@bayon/runners/script`): wait for `send`, emit canonical JSONL, exit only on stdin EOF.
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { systemClock, type Result } from "@bayon/core";
import {
  listMissionsForExport,
  listTickets,
  listTicketEvents,
  listTicketGates,
  listTicketHandoffs,
  openDbReadOnly,
  type Db,
} from "@bayon/db";
import { emit, readGo, readOps, type ScriptIo } from "@bayon/runners/script";
import { z } from "zod";
import { sessionDir } from "../paths.js";
import { loadExportSettings } from "./export-settings.js";
import { commitExportChanges, ensureExportRepo } from "./git-export.js";
import {
  runExport,
  type ExportFs,
  type ExportMission,
  type ExportTicket,
} from "./run-export.js";

const Env = z.object({
  FRM_HOME: z.string().min(1),
  FRM_DB: z.string().min(1),
  FRM_SESSION_ID: z.string().min(1),
});

const ZERO_USAGE = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

function unwrapOrThrow<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new Error(`${r.error.class}: ${r.error.message}`);
}

const isMissing = (e: unknown): boolean =>
  e instanceof Error && "code" in e && e.code === "ENOENT";

const realFs: ExportFs = {
  readFile: async (path) => {
    try {
      return await fsReadFile(path, "utf8");
    } catch (e) {
      if (isMissing(e)) return undefined;
      throw e;
    }
  },
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, content, "utf8");
  },
  readdir: async (path) => {
    try {
      return await fsReaddir(path);
    } catch (e) {
      if (isMissing(e)) return [];
      throw e;
    }
  },
  unlink: async (path) => {
    await fsUnlink(path);
  },
};

/** Every ticket_events row for one ticket, paged (1000 at a time -- generous for M1's expected
 * volume; a ticket with more transitions than that pages transparently). */
async function loadAllEvents(db: Db, ticketId: string) {
  const rows = [];
  let since = 0;
  for (;;) {
    const page = unwrapOrThrow(
      await listTicketEvents(db, { ticket_id: ticketId, since, limit: 1000 }),
    );
    rows.push(...page.rows);
    if (!page.hasMore) return rows;
    since = page.nextCursor;
  }
}

/** Every ticket, num order, enriched with its gates, transition log and hand-offs -- the parts of
 * §10.5's export that migration 003 adds. */
async function loadTickets(db: Db): Promise<readonly ExportTicket[]> {
  const rows = [];
  let after = 0;
  for (;;) {
    const page = unwrapOrThrow(
      await listTickets(db, { after_num: after, limit: 1000 }),
    );
    rows.push(...page.rows);
    if (!page.hasMore) break;
    after = page.nextCursor;
  }
  return Promise.all(
    rows.map(async (t): Promise<ExportTicket> => {
      const gates = unwrapOrThrow(await listTicketGates(db, t.id));
      const handoffs = unwrapOrThrow(await listTicketHandoffs(db, t.id));
      const events = await loadAllEvents(db, t.id);
      return {
        id: t.id,
        num: t.num,
        view: {
          title: t.title,
          status: t.status,
          type: t.type,
          tier: t.complexity_tier,
          priority: t.priority,
          costUsd: t.cost_usd,
          branch: t.branch,
          prUrl: t.pr_url,
          bodyMd: t.body_md,
          acceptanceMd: t.acceptance_md,
          gates: gates.map((g) => ({ kind: g.kind, state: g.state })),
          events: events.map((e) => ({
            kind: e.kind,
            actor:
              e.actor_id === null
                ? e.actor_kind
                : `${e.actor_kind}:${e.actor_id}`,
            reason: e.reason,
            createdAt: e.ts,
          })),
          handoffs: handoffs.map((h) => ({
            fromSessionId: h.from_session_id,
            toSessionId: h.to_session_id,
            createdAt: h.created_at,
          })),
        },
      };
    }),
  );
}

async function loadMissions(db: Db): Promise<readonly ExportMission[]> {
  const rows = unwrapOrThrow(await listMissionsForExport(db));
  return rows.map((m) => ({
    agentName: m.agent_name,
    version: m.version,
    renderedMd: m.rendered_md,
  }));
}

function fail(io: ScriptIo, message: string, manifestPath?: string): void {
  emit(io, {
    kind: "error",
    runner_type: "export.error",
    payload: { class: "internal", message, retryable: false },
  });
  emit(io, {
    kind: "terminal",
    runner_type: "export.terminal",
    payload: {
      outcome: "failed",
      error: { class: "internal", message, retryable: false },
      usage: ZERO_USAGE,
      cost_usd: 0,
      ...(manifestPath === undefined ? {} : { manifest_path: manifestPath }),
    },
  });
}

async function runOnce(io: ScriptIo): Promise<void> {
  emit(io, {
    kind: "session_init",
    runner_type: "export.init",
    payload: { runner_session_id: randomUUID(), model: "script" },
  });

  const env = Env.safeParse(process.env);
  if (!env.success)
    return fail(io, `bad environment: ${z.prettifyError(env.error)}`);

  const db = await openDbReadOnly({
    path: env.data.FRM_DB,
    clock: systemClock,
  });
  if (!db.ok)
    return fail(io, `cannot open the database read-only: ${db.error.message}`);

  const logsDir = join(
    sessionDir(env.data.FRM_HOME, env.data.FRM_SESSION_ID),
    "logs",
  );
  const manifestPath = join(logsDir, "export-manifest.json");

  try {
    const settings = unwrapOrThrow(await loadExportSettings(db.value));
    const exportsDir =
      settings["exports.repo_path"] ?? join(env.data.FRM_HOME, "exports");

    const result = await runExport({
      listTickets: () => loadTickets(db.value),
      listMissions: () => loadMissions(db.value),
      fs: realFs,
      ensureRepo: ensureExportRepo,
      commit: commitExportChanges,
      clock: systemClock,
      exportsDir,
      keyPrefix: settings["tickets.key_prefix"],
    });

    for (const step of result.gitSteps) {
      emit(io, {
        kind: "command",
        runner_type: "export.git",
        exit_code: step.exitCode,
        payload: {
          argv: step.argv,
          cwd: exportsDir,
          duration_ms: step.durationMs,
        },
      });
    }

    await mkdir(logsDir, { recursive: true });
    await fsWriteFile(manifestPath, JSON.stringify(result.manifest), "utf8");

    if (result.outcome === "ok") {
      emit(io, {
        kind: "terminal",
        runner_type: "export.terminal",
        payload: {
          outcome: "ok",
          usage: ZERO_USAGE,
          cost_usd: 0,
          manifest_path: manifestPath,
          committed: result.committed,
        },
      });
    } else {
      fail(
        io,
        result.error ?? "export failed for an unknown reason",
        manifestPath,
      );
    }
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  } finally {
    await db.value.close();
  }
}

/** Reads stdin to its end regardless of what `runOnce` did: the job exits only on stdin EOF (never
 * self-terminates), exactly like the fixture runner. */
async function main(): Promise<void> {
  const io: ScriptIo = {
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
  };
  const ops = readOps(process.stdin);
  const go = await readGo(ops);
  if (go !== undefined) await runOnce(io);
  for (;;) {
    const next = await ops.next();
    if (next.done === true) break;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && entry.endsWith("export-markdown.js");
}

if (isMain()) {
  await main();
  process.exitCode = 0;
}
