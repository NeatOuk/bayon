// Live evidence (design §9): the real bundled CLI against the real API, through the real local
// executor. CI never sets FRM_REAL_RUNNER, so this is skipped there; until a credential is in the
// host store, the stub-CLI tests in adapter.test.ts are the M0 evidence. Either credential works:
//   FRM_REAL_RUNNER=1 ANTHROPIC_API_KEY=… pnpm vitest run packages/runners/src/adapters/claude-sdk/live.test.ts
//   FRM_REAL_RUNNER=1 CLAUDE_CODE_OAUTH_TOKEN=… (from `claude setup-token`) pnpm vitest run …
//   FRM_RECORD=1 also writes the raw stdout to fixtures/claude-sdk/recorded/ (gitignored).
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventKind } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { DEFAULTS, MODELS } from "./registration.js";

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";
const RECORD = process.env["FRM_RECORD"] === "1";
const RECORDED = fileURLToPath(
  new URL("../../../fixtures/claude-sdk/recorded/", import.meta.url),
);

describe.skipIf(!LIVE)("the live runner", { timeout: 600_000 }, () => {
  // Whichever credential the operator has, first in the registration's one-of order.
  const auth = DEFAULTS.secretEnvAnyOf.flat().find((name) => process.env[name]);
  const key = auth === undefined ? "" : (process.env[auth] ?? "");
  // Made in beforeAll, not here: this body runs at collection even when the suite is skipped, and a
  // skipped suite's afterAll never runs, so every plain run leaked an empty directory.
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "frm-live-")));
  });
  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
  const adapter = createClaudeSdkAdapter();
  const raw: string[] = [];

  function repo(): string {
    const dir = join(root, "repo");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# live\n");
    // A repo setting that conflicts with ours: our inline permission mode must win.
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "plan" } }),
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=frm", "-c", "user.email=frm@localhost", "add", ".");
    git(
      "-c",
      "user.name=frm",
      "-c",
      "user.email=frm@localhost",
      "commit",
      "-qm",
      "init",
    );
    return dir;
  }

  function reader(records: AsyncIterable<RawRecord>) {
    const iterator = records[Symbol.asyncIterator]();
    const mapper = adapter.createMapper({ prices: MODELS });
    let offset = 0;
    return async (): Promise<MappedEvent[]> => {
      const out: MappedEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        raw.push(new TextDecoder().decode(next.value.bytes));
        const events = mapper.map({
          offset,
          bytes: next.value.bytes,
          ts: Date.now(),
          partial: next.value.partial,
        });
        offset += next.value.bytes.length + 1;
        out.push(...events);
        if (events.some((e) => e.kind === "terminal")) return out;
      }
    };
  }

  test("a real session: an edit, git diff, tokens, a second run, an interrupt", async () => {
    expect(key).not.toBe("");
    const health = await adapter.health(local);
    expect(health.ok).toBe(true);

    const cwd = repo();
    const homeDir = join(root, "home");
    const cheap = MODELS.find((m) => m.tier === "cheap");
    const spec: SpawnSpec = {
      sessionId: "01LIVE",
      cwd,
      homeDir,
      env: {
        PATH: process.env["PATH"] ?? "",
        ...(auth === undefined ? {} : { [auth]: key }),
      },
      model: cheap?.model ?? "",
      flags: {
        ...DEFAULTS,
        allowedTools: ["Read", "Edit", "Bash(git diff:*)"],
      },
    };
    expect((await adapter.prepareHome(spec)).ok).toBe(true);
    const spawned = await adapter.spawn(spec, local);
    if (!spawned.ok) throw new Error(spawned.error.message);
    const h: SessionHandle = spawned.value;
    const run = reader(adapter.records(h));

    await adapter.send(h, {
      runId: "live-1",
      text: "Append the line `live check` to README.md, then run `git diff --stat`.",
      promptPath: "/live/run-1.md",
    });
    const run1 = await run();
    const kinds = run1.map((e) => e.kind);
    const want: EventKind[] = [
      "session_init",
      "turn_start",
      "tool_call",
      "tool_result",
      "file_change",
      "turn_end",
      "terminal",
    ];
    let at = 0;
    for (const k of want) {
      at = kinds.indexOf(k, at);
      expect(at, k).toBeGreaterThanOrEqual(0);
      at += 1;
    }
    expect(kinds.filter((k) => k === "terminal")).toHaveLength(1);
    expect(run1[0]?.payload).toMatchObject({
      runner_session_id: h.runnerSessionId,
      permission_mode: "acceptEdits",
    });
    expect(readFileSync(join(cwd, "README.md"), "utf8")).toContain(
      "live check",
    );
    expect(
      execFileSync("git", ["-C", cwd, "diff", "--numstat"], {
        encoding: "utf8",
      }),
    ).toMatch(/^1\s+0\s+README\.md/m);
    const terminal = run1.at(-1);
    expect(terminal?.payload).toMatchObject({ outcome: "ok" });
    expect(
      (terminal?.payload["spend"] as { tokens_out: number }).tokens_out,
    ).toBeGreaterThan(0);

    // A second run in the same process (§15 #3), then an interrupt (§15 #7).
    await adapter.send(h, {
      runId: "live-2",
      text: "Reply with the single word done.",
      promptPath: "/live/run-2.md",
    });
    expect((await run()).at(-1)?.payload).toMatchObject({ outcome: "ok" });
    await adapter.send(h, {
      runId: "live-3",
      text: "Count slowly from 1 to 500, one number per line.",
      promptPath: "/live/run-3.md",
    });
    const asked = Date.now();
    expect((await adapter.interrupt(h)).ok).toBe(true);
    expect((await run()).at(-1)?.payload).toMatchObject({
      outcome: "interrupted",
    });
    expect(Date.now() - asked).toBeLessThan(5_000);

    // Run n after an interrupt (§15 #7 "session still usable"; hand-off run is one):
    // the same process takes a new run, and it ends ok on its own terminal.
    await adapter.send(h, {
      runId: "live-4",
      text: "Reply with the single word done.",
      promptPath: "/live/run-4.md",
    });
    const run4 = await run();
    expect(run4.filter((e) => e.kind === "terminal")).toHaveLength(1);
    expect(run4.at(-1)?.payload).toMatchObject({ outcome: "ok" });

    await adapter.stop(h, "graceful");
    if (RECORD) {
      const text = `${raw.join("\n")}\n`;
      expect(text.includes(key)).toBe(false); // never write the key to a fixture
      mkdirSync(RECORDED, { recursive: true });
      writeFileSync(join(RECORDED, `live-${Date.now()}.jsonl`), text);
    }
  });
});
