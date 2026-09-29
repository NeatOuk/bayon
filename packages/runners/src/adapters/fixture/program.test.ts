import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  noFetch,
  removeTempDirs,
  start,
  tempDir,
  untilTerminal,
} from "./program-harness.js";
import { STATE_FILE, runFixture, type FixtureScriptInput } from "./program.js";

afterEach(removeTempDirs);

const send = { op: "send", runId: "run-1", text: "go" };

describe("the default script", () => {
  test("is silent until send, then writes the Done-when sequence and a real edit", async () => {
    const h = start({});
    h.op(send);
    const kinds: unknown[] = [];
    for (;;) {
      const line = await h.next();
      kinds.push(line["kind"]);
      if (line["kind"] === "terminal") {
        expect(line["payload"]).toEqual({
          outcome: "ok",
          cumulative: {
            "fixture-model": {
              tokens_in: 100,
              tokens_out: 20,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              cost_usd: 0.001,
            },
          },
        });
        break;
      }
    }
    expect(kinds).toEqual([
      "session_init",
      "turn_start",
      "tool_call",
      "tool_result",
      "file_change",
      "zz_unknown",
      "turn_end",
      "terminal",
    ]);
    expect(readFileSync(join(h.cwd, "README.md"), "utf8")).toBe(
      "fixture was here\n",
    );
    h.eof();
    expect(await h.exit).toBe(0);
  });

  test("a second run adds to the running totals and does not repeat session_init", async () => {
    const h = start({});
    h.op(send);
    while ((await h.next())["kind"] !== "terminal");
    h.op({ ...send, runId: "run-2" });
    const first = await h.next();
    expect(first["kind"]).toBe("turn_start");
    let last = first;
    while (last["kind"] !== "terminal") last = await h.next();
    expect(last["payload"]).toMatchObject({
      cumulative: { "fixture-model": { tokens_in: 200, cost_usd: 0.002 } },
    });
    h.eof();
    await h.exit;
  });

  test("exits 0 on stdin EOF without any send", async () => {
    const h = start({});
    h.eof();
    expect(await h.exit).toBe(0);
    expect(h.lines()).toEqual([]);
  });
});

describe("scripted runs", () => {
  const events = [{ kind: "turn_start", runner_type: "t", payload: {} }];

  test("commit: the appends are committed before the events; a failed commit fails the run", async () => {
    const cwd = tempDir();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@frm.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
    const env = { PATH: process.env["PATH"] };
    const committed = start({
      cwd,
      env,
      script: {
        runs: [
          { appends: [{ path: "add.js", text: "a + b\n" }], commit: "work" },
        ],
      },
    });
    committed.op(send);
    expect((await untilTerminal(committed)).at(-1)?.["payload"]).toMatchObject({
      outcome: "ok",
    });
    expect(git("log", "-1", "--format=%s")).toBe("work");
    expect(git("show", "HEAD:add.js")).toBe("a + b");
    expect(git("status", "--porcelain")).toBe("");
    committed.eof();
    await committed.exit;
    // Nothing left to commit: the run ends failed, and no event of the run is written.
    const empty = start({
      cwd,
      env,
      script: { runs: [{ events, commit: "nothing" }] },
    });
    empty.op(send);
    const lines = await untilTerminal(empty);
    expect(lines.map((l) => l["kind"])).toEqual(["session_init", "terminal"]);
    expect(lines.at(-1)?.["payload"]).toMatchObject({
      outcome: "failed",
      error: { class: "internal", message: expect.stringMatching(/^commit: /) },
    });
    empty.eof();
    await empty.exit;
  });

  test("a gated run waits for release", async () => {
    const h = start({ script: { runs: [{ events, gate: "release" }] } });
    h.op(send);
    expect((await h.next())["kind"]).toBe("session_init");
    expect((await h.next())["kind"]).toBe("turn_start");
    h.op(send); // ignored: a run is open
    h.op({ op: "release" });
    expect((await h.next())["kind"]).toBe("terminal");
    h.eof();
    await h.exit;
    expect(h.lines()).toHaveLength(3);
  });

  test("interrupt ends a gated or hanging run with terminal{interrupted}", async () => {
    for (const run of [
      { events, gate: "release" as const },
      { events, then: "hang" as const },
    ]) {
      const h = start({ script: { runs: [run] } });
      h.op(send);
      await h.next();
      await h.next();
      h.op({ op: "interrupt" });
      const terminal = await h.next();
      expect(terminal).toMatchObject({
        kind: "terminal",
        payload: { outcome: "interrupted" },
      });
      h.eof();
      expect(await h.exit).toBe(0);
    }
  });

  test("hard_hang ignores interrupt and SIGTERM but still exits on EOF", async () => {
    const h = start({ script: { runs: [{ events, then: "hard_hang" }] } });
    h.op(send);
    await h.next();
    await h.next();
    h.op({ op: "interrupt" });
    h.eof();
    expect(await h.exit).toBe(0);
    expect(h.termIgnored()).toBe(true);
    expect(h.lines().map((l) => l["kind"])).toEqual([
      "session_init",
      "turn_start",
    ]);
  });

  test("crash kills the process mid-run", async () => {
    const h = start({ script: { runs: [{ events, then: "crash" }] } });
    h.op(send);
    expect(await h.exit).toBe(137);
    expect(h.crashes()).toBe(1);
    expect(h.lines().map((l) => l["kind"])).toEqual([
      "session_init",
      "turn_start",
    ]);
  });

  test("exit0 exits cleanly with the run still open", async () => {
    const h = start({ script: { runs: [{ events, then: "exit0" }] } });
    h.op(send);
    expect(await h.exit).toBe(0);
    expect(h.lines().map((l) => l["kind"])).toEqual([
      "session_init",
      "turn_start",
    ]);
  });

  test("a terminal can carry a scripted outcome and spend", async () => {
    const spend = {
      tokens_in: 7,
      tokens_out: 1,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd: 0.5,
    };
    const h = start({
      script: { runs: [{ terminal: { outcome: "failed" }, spend }] },
    });
    h.op(send);
    await h.next();
    expect(await h.next()).toMatchObject({
      kind: "terminal",
      payload: { outcome: "failed", cumulative: { "fixture-model": spend } },
    });
    h.eof();
    await h.exit;
  });

  test("an invalid spec exits 2", async () => {
    const stderr: string[] = [];
    const code = await runFixture({
      argv: ["fixture", "--spec", "{}"],
      cwd: tempDir(),
      env: {},
      fetch: noFetch,
      stdin: (async function* () {})(),
      stdout: { write: () => {} },
      stderr: { write: (c) => void stderr.push(c) },
      crash: async () => 137,
      ignoreTerm: () => {},
    });
    expect(code).toBe(2);
    expect(stderr.join("")).toContain("invalid --spec");
  });
});

describe("resume", () => {
  const events = [{ kind: "turn_start", runner_type: "t", payload: {} }];
  const script: FixtureScriptInput = {
    runs: [
      { events },
      { events: [{ kind: "zz_second", runner_type: "t", payload: {} }] },
    ],
  };

  test("persists its position and resumes with the same session id at the next run", async () => {
    const first = start({ script });
    first.op(send);
    while ((await first.next())["kind"] !== "terminal");
    first.eof();
    await first.exit;
    expect(
      JSON.parse(readFileSync(join(first.home, STATE_FILE), "utf8")),
    ).toEqual({
      runnerSessionId: "rs-1",
      runIndex: 1,
      eventIndex: 0,
    });

    const second = start({ script, resume: true, home: first.home });
    second.op(send);
    expect(await second.next()).toMatchObject({
      kind: "session_init",
      payload: { runner_session_id: "rs-1" },
    });
    expect((await second.next())["kind"]).toBe("zz_second");
    second.eof();
    await second.exit;
  });

  test("a run cut off mid-way is abandoned on resume", async () => {
    const home = tempDir();
    writeFileSync(
      join(home, STATE_FILE),
      JSON.stringify({ runnerSessionId: "rs-1", runIndex: 0, eventIndex: 2 }),
    );
    const h = start({ script, resume: true, home });
    h.op(send);
    await h.next();
    expect((await h.next())["kind"]).toBe("zz_second");
    h.eof();
    await h.exit;
  });

  test("resuming without matching state exits 3", async () => {
    const h = start({ script, resume: true, runnerSessionId: "other" });
    expect(await h.exit).toBe(3);
    expect(h.stderr()).toContain("no state to resume other");
  });

  test("crash_on_resume crashes at once, before any send", async () => {
    const h = start({
      script: { ...script, crash_on_resume: true },
      resume: true,
    });
    expect(await h.exit).toBe(137);
    expect(h.crashes()).toBe(1);
    expect(h.lines()).toEqual([]);
  });
});
