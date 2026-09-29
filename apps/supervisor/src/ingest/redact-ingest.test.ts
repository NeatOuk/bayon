// Design an earlier change §3 and test 15 at the ingest level: a session echoes its MCP token and a secret
// (an `env` dump), small and big enough to spill. Neither reaches the raw log, an events row or any
// file under logs/ (Invariant 11).
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  newRunInput,
  newSessionInput,
  seedSpine,
  tempDb,
  unwrap,
} from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { rawLogPath } from "../paths.js";
import { ingestHarness } from "../testing/ingest-harness.js";
import { createIngest } from "./ingest.js";
import { REDACTED } from "./redact.js";

const clock = new FakeClock(1_700_000_000_000);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
const home = mkdtempSync("/tmp/frm-redact-");
afterAll(() => {
  t.cleanup();
  rmSync(home, { recursive: true, force: true });
});
const h = ingestHarness({
  db: t.db,
  home,
  sessionInput: newSessionInput,
  runInput: newRunInput,
});

const TOKEN = "Zm9yZW1hbi1tY3AtdG9rZW4tZm9yLXRlc3RzLTAxMjM"; // base64url, like a minted one
const SECRET = "sk-live-0123456789abcdef";

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));

test("an echoed MCP token and secret never reach the raw log, events or spill files", async () => {
  const ingest = createIngest({
    db: t.db,
    clock,
    log: pino({ level: "silent" }),
  });
  const sessionId = await h.session();
  const dump = `FRM_MCP_TOKEN=${TOKEN}\nSECRET=${SECRET}`;
  const big = `${dump}\n${"line\n".repeat(300)}${dump}`;
  const s = await h.start(
    ingest,
    sessionId,
    {
      runs: [
        {
          events: [
            {
              kind: "assistant_text",
              runner_type: "fixture.text",
              text: `my token is ${TOKEN}`,
              payload: {},
            },
            {
              kind: "tool_result",
              runner_type: "fixture.tool",
              status: "ok",
              text: dump,
              payload: { call_id: "c-small" },
            },
            {
              kind: "tool_result",
              runner_type: "fixture.tool",
              status: "ok",
              text: big,
              payload: { call_id: "c-big" },
            },
          ],
        },
      ],
    },
    { redact: [TOKEN, SECRET] },
  );
  const run = await h.send(ingest, s);
  expect(await ingest.terminalOf(run)).toBe("ok");
  await h.adapter.stop(s.handle, "graceful");
  await s.attachment.closed;

  const rows = await h.stored(sessionId);
  expect(rows.some((r) => r.truncated === 1)).toBe(true); // the big one spilled
  const raw = readFileSync(rawLogPath(home, sessionId), "utf8");
  expect(raw).toContain(REDACTED);
  const everywhere = [
    ...filesUnder(dirname(rawLogPath(home, sessionId))),
    ...rows.flatMap((r) => [r.text ?? "", r.payload_json ?? ""]),
  ];
  for (const text of everywhere) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
  }
});
