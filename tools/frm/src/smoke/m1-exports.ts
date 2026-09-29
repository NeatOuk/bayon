import { readFileSync } from "node:fs";
import { join } from "node:path";
import { err, newId, ok, sha256Hex, type Result } from "@bayon/core";
import { getTicket, listTicketExports, type TicketExportRow } from "@bayon/db";
import { seedConfig } from "@bayon/db/operator";
import type { EventItem } from "@bayon/proto";
import { z } from "zod";
import { COMMAND_TIMEOUT_MS } from "./budget.js";
import { pollUntil } from "./deadline.js";
import { exportedFileProblems, type ExportedFile } from "./export-checks.js";
import { exporterRows } from "./export-config.js";
import { git } from "./fixture-repo.js";
import { follow, hasKind, terminalOf } from "./follow.js";
import { refuse, verdict } from "./harness.js";
import { commandDone, eventsUntil, type World } from "./phases.js";

// The M1 export (contract 6): POST /exports/run commits both tickets' files, each matching the
// DB; a second export over unchanged tickets makes no commit.

/** A ticket the export must hold. */
export interface Exported {
  readonly id: string;
  readonly key: string;
}

const RunResult = z.object({ session_id: z.string().min(1) });
const ExportTerminal = z.looseObject({
  outcome: z.string(),
  committed: z.boolean().optional(),
});

/** The exporter's terminal: ok, and whether it committed. */
function exportEnded(items: readonly EventItem[]): Result<boolean> {
  const t = ExportTerminal.safeParse(terminalOf(items)?.payload);
  if (!t.success) return err(refuse("the exporter wrote no terminal"));
  if (t.data.outcome !== "ok")
    return err(refuse(`the export ended ${t.data.outcome}`));
  return t.data.committed === undefined
    ? err(refuse("the exporter's terminal does not say whether it committed"))
    : ok(t.data.committed);
}

/** One POST /exports/run, through its exporter session's terminal. */
async function exportOnce(
  w: World,
  label: string,
): Promise<{ readonly sessionId: string; readonly committed: boolean }> {
  const accepted = await w.h.step(`POST /exports/run (${label})`, () =>
    w.api.exportsRun(`smoke:export:${label}:${newId(w.h.clock.now())}`),
  );
  const done = await w.h.step(`export.run command done (${label})`, () =>
    commandDone(w, accepted.command_id),
  );
  const run = RunResult.safeParse(done.result);
  if (!run.success)
    throw new Error(`export.run's result: ${JSON.stringify(done.result)}`);
  const sessionId = run.data.session_id;
  w.h.track(sessionId);
  const events = follow(w.h.client(w.wsUrl, w.token), sessionId);
  const items = await w.h.step(`the exporter's terminal (${label})`, () =>
    eventsUntil(w, events, "the exporter's terminal", hasKind("terminal")),
  );
  const committed = await w.h.step(`the export ended ok (${label})`, async () =>
    exportEnded(items),
  );
  return { sessionId, committed };
}

/** Commits in the exports repo. */
function commitCount(dir: string): Result<number> {
  try {
    return ok(Number(git(dir, ["rev-list", "--count", "HEAD"]).trim()));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return err(refuse(`no commit in ${dir}: ${why}`));
  }
}

/** Each ticket's ticket_exports row, once the supervisor has reconciled the manifest. */
function exportRows(
  w: World,
  tickets: readonly Exported[],
): Promise<Result<ReadonlyMap<string, TicketExportRow>>> {
  let seen = "none";
  return pollUntil(
    {
      clock: w.h.clock,
      timeoutMs: COMMAND_TIMEOUT_MS,
      intervalMs: 100,
      what: "ticket_exports rows for every ticket",
      detail: () => `synced: ${seen}`,
    },
    async () => {
      const rows = new Map<string, TicketExportRow>();
      for (const t of tickets) {
        const listed = await listTicketExports(w.db, t.id);
        if (!listed.ok) return listed;
        const row = listed.value.find((r) => r.target === "markdown");
        if (row?.content_hash != null) rows.set(t.id, row);
      }
      seen = [...rows.keys()].join(", ") || "none";
      return ok(rows.size === tickets.length ? rows : undefined);
    },
  );
}

/** Each file against its row and the DB: path, synced, frontmatter status, content_hash. */
async function filesMatch(
  w: World,
  dir: string,
  tickets: readonly Exported[],
  rows: ReadonlyMap<string, TicketExportRow>,
): Promise<Result<void>> {
  const problems: string[] = [];
  for (const t of tickets) {
    const ticket = await getTicket(w.db, t.id);
    if (!ticket.ok) return ticket;
    const row = rows.get(t.id);
    const text = row?.path == null ? undefined : readText(join(dir, row.path));
    const file: ExportedFile = {
      key: t.key,
      dbStatus: ticket.value.status,
      row,
      text,
      sha256: text === undefined ? undefined : await sha256Hex(text),
    };
    problems.push(...exportedFileProblems(file));
  }
  return verdict(problems);
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The exporter seeded, then two exports: the first commits both files, the second nothing. */
export async function exportsTwice(
  w: World,
  tickets: readonly Exported[],
): Promise<void> {
  await w.h.step("the exporter's run class, profile and agent", async () =>
    seedConfig(
      w.db,
      await exporterRows({ now: w.h.clock.now(), home: w.h.home }),
    ),
  );
  const dir = join(w.h.home, "exports");
  const first = await exportOnce(w, "first");
  const commits = await w.h.step(
    "the first export made one commit",
    async () => {
      const n = commitCount(dir);
      if (!n.ok) return n;
      return first.committed && n.value === 1
        ? ok(n.value)
        : err(refuse(`committed: ${first.committed}, commits: ${n.value}`));
    },
  );
  const rows = await w.h.step("ticket_exports holds every ticket, synced", () =>
    exportRows(w, tickets),
  );
  await w.h.step(
    "each file: frontmatter status = the DB's, content_hash = ticket_exports'",
    () => filesMatch(w, dir, tickets, rows),
  );
  // An exporter session stays live after its run: stop it, so the second export runs afresh.
  const stop = await w.h.step(
    "POST /sessions/:id/stop (the first exporter)",
    () =>
      w.api.stop(
        first.sessionId,
        "graceful",
        `smoke:export:stop:${first.sessionId}`,
      ),
  );
  await w.h.step("stop command done", () => commandDone(w, stop.command_id));
  const second = await exportOnce(w, "second");
  await w.h.step("the second export, nothing changed: no commit", async () => {
    const n = commitCount(dir);
    if (!n.ok) return n;
    return verdict([
      ...(second.sessionId === first.sessionId
        ? ["the second export reused the first's session"]
        : []),
      ...(second.committed ? ["the second export committed"] : []),
      ...(n.value === commits
        ? []
        : [`the exports repo went from ${commits} to ${n.value} commits`]),
    ]);
  });
}
