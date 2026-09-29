// The two pieces of exporter evidence the design doc promises: a failing export session produces
// an `export_failed` attention row, and (via run-export.test.ts / git-export.test.ts already) a
// second unchanged run writes nothing. This file proves the failure path end to end against a real
// migrated database (003 included), from a raw terminal event through to `v_needs_attention`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { listNeedsAttention } from "@bayon/db";
import { appendRun } from "@bayon/db/supervisor";
import {
  SPINE_SEED,
  addSession,
  newRunInput,
  seedRows,
  seedSpine,
  ticketRow,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { handleExportTerminal } from "./export-terminal.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
afterAll(() => t.cleanup());
unwrap(await seedSpine(t.db, 2));

const dir = mkdtempSync(join(tmpdir(), "frm-export-terminal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const log = pino({ level: "silent" });
const EXPORTER_AGENT = SPINE_SEED.agentId;

/** A session, a run and a terminal event whose payload carries `manifest_path`, mirroring exactly
 * what the real script adapter's mapper would have committed. Inserted directly via `seedRows`
 * (bypassing `insertEventsBatch`'s raw_offset business rule, which does not apply to this synthetic
 * fixture) since only the payload's shape matters here, not how a real ingest batch would number it. */
async function sessionWithTerminal(
  sessionId: string,
  outcome: string,
  manifestPath: string | undefined,
): Promise<string> {
  unwrap(await addSession(t.db, sessionId));
  const run = unwrap(await appendRun(t.db, newRunInput(sessionId)));
  const payload =
    manifestPath === undefined
      ? { outcome }
      : { outcome, manifest_path: manifestPath };
  unwrap(
    await seedRows(t.db, {
      events: [
        {
          session_id: sessionId,
          run_id: run.id,
          ts: clock.now(),
          kind: "terminal",
          runner_type: "export.terminal",
          tool_name: null,
          status: null,
          exit_code: null,
          text: null,
          payload_json: JSON.stringify(payload),
          payload_path: null,
          bytes_original: null,
          raw_offset: -1,
        },
      ],
    }),
  );
  return run.id;
}

function writeManifest(
  name: string,
  entries: readonly Record<string, unknown>[],
): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ v: 1, entries, removed: [] }));
  return path;
}

test("a successful export upserts every manifest entry as synced", async () => {
  unwrap(await seedRows(t.db, { tickets: [ticketRow(101, { id: "tkt-ok" })] }));
  const manifestPath = writeManifest("manifest-ok.json", [
    {
      ticket_id: "tkt-ok",
      target: "markdown",
      path: "tickets/T-101.md",
      content_hash: "a".repeat(64),
    },
  ]);
  const runId = await sessionWithTerminal("export-ok", "ok", manifestPath);

  await handleExportTerminal(
    { db: t.db, clock, log, exporterAgentId: EXPORTER_AGENT },
    { sessionId: "export-ok", runId, outcome: "ok" },
  );

  const attention = unwrap(await listNeedsAttention(t.db));
  expect(
    attention.some(
      (a) => a.why === "export_failed" && a.ticket_id === "tkt-ok",
    ),
  ).toBe(false);
});

test("a failing export session marks its manifest entries failed, surfaced in v_needs_attention", async () => {
  unwrap(
    await seedRows(t.db, { tickets: [ticketRow(102, { id: "tkt-fail" })] }),
  );
  const manifestPath = writeManifest("manifest-fail.json", [
    {
      ticket_id: "tkt-fail",
      target: "markdown",
      path: "tickets/T-102.md",
      content_hash: "b".repeat(64),
    },
  ]);
  const runId = await sessionWithTerminal(
    "export-fail",
    "failed",
    manifestPath,
  );

  await handleExportTerminal(
    { db: t.db, clock, log, exporterAgentId: EXPORTER_AGENT },
    { sessionId: "export-fail", runId, outcome: "failed" },
  );

  const attention = unwrap(await listNeedsAttention(t.db));
  const row = attention.find(
    (a) => a.why === "export_failed" && a.ticket_id === "tkt-fail",
  );
  expect(row).toBeDefined();
  expect(row?.ref).toBe("markdown");
});

test("a terminal with no manifest_path (a crash before it was written) is a silent no-op", async () => {
  const runId = await sessionWithTerminal("export-crash", "failed", undefined);
  await expect(
    handleExportTerminal(
      { db: t.db, clock, log, exporterAgentId: EXPORTER_AGENT },
      { sessionId: "export-crash", runId, outcome: "failed" },
    ),
  ).resolves.toBeUndefined();
});

test("a terminal from a session that is not the exporter agent is ignored", async () => {
  await expect(
    handleExportTerminal(
      { db: t.db, clock, log, exporterAgentId: "some-other-agent" },
      { sessionId: SPINE_SEED.sessionId, runId: "no-such-run", outcome: "ok" },
    ),
  ).resolves.toBeUndefined();
});
