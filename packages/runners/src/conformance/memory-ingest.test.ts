// The reference ingest, pinned to the supervisor's ingest laws: each test replays the named case of
// apps/supervisor/src/ingest/ingest.test.ts it mirrors.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, systemClock } from "@bayon/core";
import { FakeExecutor } from "@bayon/executors/testing";
import { afterAll, expect, test } from "vitest";
import type { SessionHandle } from "../adapter.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
  type FixtureScriptInput,
} from "../adapters/fixture/index.js";
import { createMemoryIngest } from "./memory-ingest.js";
import type { IngestPort } from "./types.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-mem-ingest-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fake = new FakeExecutor({
  programs: { [FIXTURE_PROGRAM]: fixtureProgram },
});
const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM] });
const SECRET = "s3cret-token-value-0123456789abcdef";

async function started(
  ingest: IngestPort,
  script: FixtureScriptInput,
  redact: readonly string[] = [],
): Promise<{ readonly sessionId: string; readonly handle: SessionHandle }> {
  const sessionId = newId();
  const cwd = join(root, sessionId, "work");
  const homeDir = join(root, sessionId, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const spawned = await adapter.spawn(
    {
      sessionId,
      cwd,
      homeDir,
      env: {},
      model: "fixture-model",
      flags: { script },
    },
    fake,
  );
  if (!spawned.ok) throw new Error(spawned.error.message);
  const attached = await ingest.attach({
    sessionId,
    handle: spawned.value,
    adapter,
    redact,
  });
  expect(attached.ok).toBe(true);
  return { sessionId, handle: spawned.value };
}

async function send(
  ingest: IngestPort,
  s: { readonly sessionId: string; readonly handle: SessionHandle },
): Promise<string> {
  const runId = newId();
  expect((await ingest.openRun(s.sessionId, runId)).ok).toBe(true);
  expect(
    (await adapter.send(s.handle, { runId, text: "go", promptPath: "/p" })).ok,
  ).toBe(true);
  return runId;
}

test("the first terminal of a run wins; a later one is stored as runner_native", async () => {
  const ingest = createMemoryIngest({ clock: systemClock });
  const s = await started(ingest, {
    runs: [
      {
        events: [
          {
            kind: "terminal",
            runner_type: "early",
            payload: { outcome: "failed" },
          },
        ],
      },
    ],
  });
  const runId = await send(ingest, s);
  expect(await ingest.terminalOf(runId)).toBe("failed");
  await adapter.stop(s.handle, "graceful");
  await ingest.ended(s.sessionId);
  const events = await ingest.events(s.sessionId);
  expect(events.filter((e) => e.kind === "terminal")).toHaveLength(1);
  expect(
    events.filter(
      (e) =>
        e.kind === "runner_native" && e.payload["demoted_kind"] === "terminal",
    ),
  ).toHaveLength(1);
});

test("a stream that ends mid-run gets the supervisor's terminal", async () => {
  const ingest = createMemoryIngest({ clock: systemClock });
  const s = await started(ingest, { runs: [{ then: "exit0" }] });
  const runId = await send(ingest, s);
  expect(await ingest.terminalOf(runId)).toBe("failed");
  await ingest.ended(s.sessionId);
  const terminal = (await ingest.events(s.sessionId)).find(
    (e) => e.kind === "terminal",
  );
  expect(terminal).toMatchObject({
    source: "supervisor",
    run_id: runId,
    payload: { error: { class: "runner_exited_without_terminal" } },
  });
});

test("closeRun keeps a final state, runs once, and demotes a late runner terminal", async () => {
  const ingest = createMemoryIngest({ clock: systemClock });
  const s = await started(ingest, { runs: [{ then: "hang" }] });
  const runId = await send(ingest, s);
  const close = {
    outcome: "timeout",
    errorClass: "timeout",
    message: "no terminal",
  } as const;
  expect((await ingest.closeRun(s.sessionId, runId, close)).ok).toBe(true);
  expect((await ingest.closeRun(s.sessionId, runId, close)).ok).toBe(true);
  expect(await ingest.terminalOf(runId)).toBe("timeout");
  await adapter.interrupt(s.handle); // the runner's own terminal{interrupted}, too late
  await adapter.stop(s.handle, "graceful");
  await ingest.ended(s.sessionId);
  const events = await ingest.events(s.sessionId);
  expect(events.filter((e) => e.kind === "terminal")).toEqual([
    expect.objectContaining({ source: "supervisor" }),
  ]);
  expect(
    events.some(
      (e) =>
        e.kind === "runner_native" &&
        e.source === "runner" &&
        e.payload["demoted_kind"] === "terminal",
    ),
  ).toBe(true);
  expect((await ingest.closeRun(s.sessionId, "no-such-run", close)).ok).toBe(
    false,
  );
});

test("segments: a second open run is refused", async () => {
  const ingest = createMemoryIngest({ clock: systemClock });
  const s = await started(ingest, { runs: [{ gate: "release" }] });
  const first = await send(ingest, s);
  expect(await ingest.openRun(s.sessionId, newId())).toMatchObject({
    ok: false,
    error: { class: "conflict" },
  });
  await adapter.interrupt(s.handle);
  expect(await ingest.terminalOf(first)).toBe("interrupted");
  expect((await ingest.openRun(s.sessionId, newId())).ok).toBe(true);
  await adapter.stop(s.handle, "graceful");
});

test("records are redacted before the raw append, and unknown kinds are kept", async () => {
  const ingest = createMemoryIngest({ clock: systemClock });
  const s = await started(
    ingest,
    {
      runs: [
        {
          events: [
            {
              kind: "assistant_text",
              runner_type: "text",
              text: `the token is ${SECRET}`,
              payload: {},
            },
            { kind: "zz_unknown", runner_type: "odd", payload: {} },
          ],
        },
      ],
    },
    [SECRET],
  );
  const runId = await send(ingest, s);
  await ingest.terminalOf(runId);
  await adapter.stop(s.handle, "graceful");
  await ingest.ended(s.sessionId);
  const raw = new TextDecoder().decode(await ingest.raw(s.sessionId));
  expect(raw).not.toContain(SECRET);
  expect(raw).toContain("[redacted]");
  const events = await ingest.events(s.sessionId);
  expect(JSON.stringify(events)).not.toContain(SECRET);
  expect(events.some((e) => e.kind === "runner_native")).toBe(true);
  expect(ingest.fatal()).toBeNull();
});
