// §15 #11 MCP round-trip: a tool call from inside the agent reaches /mcp with the right token, and
// the token never lands in argv, the raw log or an event (Invariant 11). Fallback: without an MCP
// client, a turn runs with no MCP call.
import type { Argv } from "@bayon/executors";
import { ECHO_TOOL } from "../mcp-probe.js";
import type { McpProbeCall, StoredEvent } from "../types.js";
import { check, define, endedWith, outcomeOf, type Branch } from "./define.js";

export type McpEvidence =
  | {
      readonly branch: "cap";
      readonly nonce: string;
      readonly token: string;
      readonly calls: readonly McpProbeCall[];
      readonly run: readonly StoredEvent[];
      readonly all: readonly StoredEvent[];
      readonly argv: readonly Argv[];
      readonly raw: string;
    }
  | { readonly branch: "fallback"; readonly run: readonly StoredEvent[] };

const named = (name: string | undefined): boolean =>
  name !== undefined && (name === ECHO_TOOL || name.endsWith(`__${ECHO_TOOL}`));

/** An ok `mcp_call` for the tool, or a tool_call for it whose result is ok. */
function streamCallOk(run: readonly StoredEvent[]): boolean {
  const viaMcp = run.some(
    (e) =>
      e.kind === "mcp_call" &&
      named(e.tool_name) &&
      e.payload["outcome"] !== "failed" &&
      e.payload["outcome"] !== "refused",
  );
  const calls = new Set(
    run.flatMap((e) =>
      e.kind === "tool_call" && named(e.tool_name) ? [e.payload.call_id] : [],
    ),
  );
  const viaTool = run.some(
    (e) =>
      e.kind === "tool_result" &&
      calls.has(e.payload.call_id) &&
      e.status === "ok",
  );
  return viaMcp || viaTool;
}

export function judgeMcp(e: McpEvidence) {
  if (e.branch === "fallback") {
    return [
      check("plain_ok", endedWith(e.run, "ok"), outcomeOf(e.run)),
      check("no_mcp_call", !e.run.some((ev) => ev.kind === "mcp_call")),
    ];
  }
  const echo = e.calls.filter((c) => c.tool === ECHO_TOOL);
  const attempted =
    echo.length > 0 ||
    e.run.some(
      (ev) =>
        (ev.kind === "mcp_call" || ev.kind === "tool_call") &&
        named(ev.tool_name),
    );
  const leaks = [
    e.argv.some((a) => a.join(" ").includes(e.token)) ? "argv" : "",
    e.raw.includes(e.token) ? "raw log" : "",
    JSON.stringify(e.all).includes(e.token) ? "events" : "",
  ].filter((where) => where !== "");
  return [
    check(
      "mcp_attempted",
      attempted,
      `${echo.length} calls reached the probe`,
      {
        precondition: true,
      },
    ),
    check(
      "probe_call_ok",
      echo.some((c) => c.bearerOk && c.args["nonce"] === e.nonce),
      echo.map((c) => (c.bearerOk ? "bearer ok" : "bearer refused")).join(", "),
    ),
    check("stream_call_ok", streamCallOk(e.run), outcomeOf(e.run)),
    check(
      "token_absent",
      leaks.length === 0,
      leaks.length === 0 ? null : `the token is in the ${leaks.join(", ")}`,
    ),
  ];
}

export const t11 = define({
  id: 11,
  retries: 1,
  fallback: () =>
    "mcpClient=false; a turn without spec.mcp ran with no MCP call",
  drive: async (ctx, branch: Branch): Promise<McpEvidence> => {
    if (branch === "fallback") {
      const live = await ctx.open({ scenario: "plain" });
      await live.spawn();
      return { branch, run: (await live.run(live.turn(0))).events };
    }
    const probe = await ctx.harness("mcp probe", ctx.ports.mcp.start());
    try {
      const live = await ctx.open({
        scenario: "mcp",
        mcp: { url: probe.url, token: probe.token, tools: probe.tools },
      });
      await live.spawn();
      const end = await live.run(live.turn(0));
      return {
        branch,
        nonce: live.vars.nonce,
        token: probe.token,
        calls: await probe.calls(),
        run: end.events,
        all: await live.events(),
        argv: ctx.subject.executor.argvOf(live.dirs.cwd),
        raw: new TextDecoder().decode(
          await ctx.ports.ingest.raw(live.sessionId),
        ),
      };
    } finally {
      await probe.stop();
    }
  },
  judge: judgeMcp,
});
