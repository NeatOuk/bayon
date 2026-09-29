import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  removeTempDirs,
  start,
  tempDir,
  untilTerminal,
} from "./program-harness.js";
import {
  FIXTURE_MCP_TOKEN_ENV,
  type FixtureFetch,
  type FixtureScriptInput,
} from "./program.js";

// Script features for a chain of sessions (the M2 smoke): `variants` picks a run list
// by what a predecessor left in the cwd, `events_after` writes events once the MCP calls are
// done, and `refusal_ok` lets a call be refused without failing the run.

afterEach(removeTempDirs);

const send = (runId: string) => ({ op: "send", runId, text: "go" });
const step = (kind: string) => ({ kind, runner_type: "t.step", payload: {} });
const kinds = (lines: readonly Record<string, unknown>[]) =>
  lines.map((l) => l["kind"]);

const MCP = {
  url: "http://127.0.0.1:1/mcp",
  tools: ["ticket_staff", "pulse_report"],
};
const env = { [FIXTURE_MCP_TOKEN_ENV]: "tok-never-printed" };

/** JSON-RPC over fetch: initialize, the notification, then each tool refused or answered. */
function server(refuses: readonly string[]): FixtureFetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as {
      readonly id?: number;
      readonly method: string;
      readonly params?: { readonly name?: string };
    };
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      });
    if (body.method === "initialize") {
      return reply({ protocolVersion: "2025-06-18", capabilities: {} });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return refuses.includes(body.params?.name ?? "")
      ? reply({
          isError: true,
          content: [{ type: "text", text: "refused" }],
          structuredContent: { refused: true, reason: "not_staffable" },
        })
      : reply({ content: [{ type: "text", text: '{"id":"x","n":1}' }] });
  };
}

describe("variants", () => {
  const script: FixtureScriptInput = {
    runs: [{ events: [step("base")] }],
    variants: [
      { exists: ".foreman/handoff-3.md", runs: [{ events: [step("third")] }] },
      {
        exists: ".foreman/handoff-2.md",
        runs: [{ events: [step("second")] }, { events: [step("second_2")] }],
      },
      { exists: ".foreman/handoff-1.md", runs: [{ events: [step("first")] }] },
    ],
  };

  function cwdWith(...files: readonly string[]): string {
    const cwd = tempDir();
    mkdirSync(join(cwd, ".foreman"));
    for (const file of files) writeFileSync(join(cwd, file), "packet\n");
    return cwd;
  }

  test("the first variant whose file is in the cwd is the run list, run after run", async () => {
    const h = start({
      script,
      cwd: cwdWith(".foreman/handoff-1.md", ".foreman/handoff-2.md"),
    });
    h.op(send("run-1"));
    expect(kinds(await untilTerminal(h))).toEqual([
      "session_init",
      "second",
      "terminal",
    ]);
    h.op(send("run-2"));
    expect(kinds(await untilTerminal(h))).toEqual(["second_2", "terminal"]);
    h.eof();
    expect(await h.exit).toBe(0);
  });

  test("no variant's file in the cwd: the script's own runs", async () => {
    const h = start({ script, cwd: cwdWith() });
    h.op(send("run-1"));
    expect(kinds(await untilTerminal(h))).toEqual([
      "session_init",
      "base",
      "terminal",
    ]);
    h.eof();
    expect(await h.exit).toBe(0);
  });
});

describe("events_after", () => {
  test("written after the MCP calls, before the gate holds the run", async () => {
    const h = start({
      script: {
        runs: [
          {
            events: [step("turn_start")],
            mcp: [{ tool: "pulse_report" }],
            events_after: [step("turn_end"), step("turn_start")],
            gate: "release",
          },
        ],
      },
      mcp: MCP,
      env,
      fetch: server([]),
    });
    h.op(send("run-1"));
    const seen = [];
    for (let i = 0; i < 5; i += 1) seen.push(await h.next());
    expect(kinds(seen)).toEqual([
      "session_init",
      "turn_start",
      "mcp_call",
      "turn_end",
      "turn_start",
    ]);
    h.op({ op: "release" });
    expect(kinds(await untilTerminal(h))).toEqual(["terminal"]);
    h.eof();
    expect(await h.exit).toBe(0);
  });

  test("not written when a call fails its expectation: the run ends failed", async () => {
    const h = start({
      script: {
        runs: [
          {
            mcp: [{ tool: "ticket_staff" }],
            events_after: [step("turn_end")],
          },
        ],
      },
      mcp: MCP,
      env,
      fetch: server(["ticket_staff"]),
    });
    h.op(send("run-1"));
    const lines = await untilTerminal(h);
    expect(kinds(lines)).toEqual(["session_init", "mcp_call", "terminal"]);
    expect(lines.at(-1)).toMatchObject({ payload: { outcome: "failed" } });
    h.eof();
    expect(await h.exit).toBe(0);
  });
});

describe("refusal_ok", () => {
  test("a refusal meets it, saves nothing, and the next step runs", async () => {
    const h = start({
      script: {
        runs: [
          {
            mcp: [
              {
                tool: "ticket_staff",
                expect: { refusal_ok: true },
                save: { staffed: "id" },
              },
              { tool: "pulse_report" },
            ],
          },
        ],
      },
      mcp: MCP,
      env,
      fetch: server(["ticket_staff"]),
    });
    h.op(send("run-1"));
    const lines = await untilTerminal(h);
    expect(lines.filter((l) => l["kind"] === "mcp_call")).toMatchObject([
      { tool_name: "ticket_staff", payload: { outcome: "refused" } },
      { tool_name: "pulse_report", payload: { outcome: "ok" } },
    ]);
    expect(lines.at(-1)).toMatchObject({ payload: { outcome: "ok" } });
    h.eof();
    expect(await h.exit).toBe(0);
  });

  test("a result must still meet `fields`", async () => {
    const h = start({
      script: {
        runs: [
          {
            mcp: [
              {
                tool: "ticket_staff",
                expect: { refusal_ok: true, fields: { n: 2 } },
              },
            ],
          },
        ],
      },
      mcp: MCP,
      env,
      fetch: server([]),
    });
    h.op(send("run-1"));
    const lines = await untilTerminal(h);
    expect(lines.at(-1)).toMatchObject({
      payload: {
        outcome: "failed",
        error: { message: expect.stringContaining("n is 1, expected 2") },
      },
    });
    h.eof();
    expect(await h.exit).toBe(0);
  });
});
