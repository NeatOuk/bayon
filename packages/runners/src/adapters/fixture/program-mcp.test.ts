import { afterEach, describe, expect, test } from "vitest";
import {
  removeTempDirs,
  start,
  untilTerminal,
  type StartOptions,
} from "./program-harness.js";
import {
  FIXTURE_MCP_TOKEN_ENV,
  type FixtureFetch,
  type FixtureScriptInput,
} from "./program.js";

// The fixture's MCP client (M1 close): a run's `mcp` steps call spec.mcp.url as plain JSON-RPC
// over fetch, with the token from the environment, one `mcp_call` event per call, and `expect`
// checked in the program itself.

afterEach(removeTempDirs);

const TOKEN = "tok-4f9a-never-printed";
const MCP_URL = "http://127.0.0.1:1/mcp";
const env = { [FIXTURE_MCP_TOKEN_ENV]: TOKEN };
const send = { op: "send", runId: "run-1", text: "go" };

type Reply =
  | { readonly data: unknown }
  | { readonly refused: string }
  | { readonly failed: string };
type Tool = (args: Readonly<Record<string, unknown>>) => Reply;

interface Seen {
  readonly method: string;
  readonly authorization: string | null;
  readonly protocol: string | null;
  readonly params: unknown;
}

interface RpcBody {
  readonly id?: number;
  readonly method: string;
  readonly params?: {
    readonly name?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A stateless MCP server answering JSON over fetch: initialize, the notification, tools/call. */
function mcpServer(tools: Readonly<Record<string, Tool>>) {
  const seen: Seen[] = [];
  const fetch: FixtureFetch = async (_url, init) => {
    const headers = new Headers(init.headers);
    const body = JSON.parse(String(init.body)) as RpcBody;
    seen.push({
      method: body.method,
      authorization: headers.get("authorization"),
      protocol: headers.get("mcp-protocol-version"),
      params: body.params,
    });
    if (body.method === "initialize") {
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "foreman", version: "1" },
        },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const tool = tools[body.params?.name ?? ""];
    const reply: Reply = tool?.(body.params?.arguments ?? {}) ?? {
      failed: "no such tool",
    };
    const result =
      "data" in reply
        ? { content: [{ type: "text", text: JSON.stringify(reply.data) }] }
        : "refused" in reply
          ? {
              isError: true,
              content: [{ type: "text", text: `refused: ${reply.refused}` }],
              structuredContent: { refused: true, reason: reply.refused },
            }
          : { isError: true, content: [{ type: "text", text: reply.failed }] };
    return json({ jsonrpc: "2.0", id: body.id, result });
  };
  return {
    fetch,
    seen,
    calls: () => seen.filter((s) => s.method === "tools/call"),
  };
}

type Steps = NonNullable<FixtureScriptInput["runs"][number]["mcp"]>;

/** One run of `steps`, on a session mounting `tools`, against `fetch`. */
function run(
  steps: Steps,
  o: Partial<StartOptions> & { readonly tools?: readonly string[] } = {},
) {
  const { tools, ...rest } = o;
  const h = start({
    script: { runs: [{ mcp: steps }] },
    mcp: {
      url: MCP_URL,
      tools: tools ?? steps.map((s) => s.tool),
    },
    env,
    ...rest,
  });
  h.op(send);
  return h;
}

const failedWith = (message: string, cls = "validation") => ({
  kind: "terminal",
  payload: {
    outcome: "failed",
    error: {
      class: cls,
      retryable: false,
      message: expect.stringContaining(message),
    },
  },
});

describe("mcp steps", () => {
  test("initializes once, calls each tool with the session's bearer, one mcp_call per call", async () => {
    const server = mcpServer({
      ticket_get: () => ({ data: { ticket: { id: "A", status: "backlog" } } }),
      human_ask: () => ({ data: { request_id: "R", status: "open" } }),
    });
    const h = run(
      [
        {
          tool: "ticket_get",
          args: { ticket: "A" },
          expect: { fields: { "ticket.status": "backlog" } },
        },
        {
          tool: "human_ask",
          args: { questions: [{ question: "q?", options: ["a", "b"] }] },
          expect: { fields: { status: "open" } },
        },
      ],
      { fetch: server.fetch },
    );
    const lines = await untilTerminal(h);
    expect(lines.map((l) => l["kind"])).toEqual([
      "session_init",
      "mcp_call",
      "mcp_call",
      "terminal",
    ]);
    expect(lines[1]).toMatchObject({
      runner_type: "fixture.mcp",
      tool_name: "ticket_get",
      payload: {
        server: "foreman",
        outcome: "ok",
        args_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(lines[2]).toMatchObject({ tool_name: "human_ask" });
    expect(lines.at(-1)).toMatchObject({ payload: { outcome: "ok" } });
    expect(server.seen.map((s) => s.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    expect(new Set(server.seen.map((s) => s.authorization))).toEqual(
      new Set([`Bearer ${TOKEN}`]),
    );
    expect(server.calls().map((c) => c.protocol)).toEqual([
      "2025-06-18",
      "2025-06-18",
    ]);
    expect(server.calls()[0]?.params).toEqual({
      name: "ticket_get",
      arguments: { ticket: "A" },
    });
    expect(JSON.stringify(h.lines()) + h.stderr()).not.toContain(TOKEN);
    h.eof();
    expect(await h.exit).toBe(0);
  });

  test("save names a value in a result; a later step passes it as {$saved}", async () => {
    const server = mcpServer({
      ticket_get: () => ({ data: { ticket: { version: 7 } } }),
      ticket_update: (args) => ({
        data: { version: Number(args["version"]) + 1 },
      }),
    });
    const h = run(
      [
        {
          tool: "ticket_get",
          args: { ticket: "A" },
          save: { v: "ticket.version" },
        },
        {
          tool: "ticket_update",
          args: { ticket: "A", version: { $saved: "v" } },
          expect: { fields: { version: 8 } },
        },
      ],
      { fetch: server.fetch },
    );
    expect((await untilTerminal(h)).at(-1)).toMatchObject({
      payload: { outcome: "ok" },
    });
    expect(server.calls()[1]?.params).toEqual({
      name: "ticket_update",
      arguments: { ticket: "A", version: 7 },
    });
    h.eof();
    await h.exit;
  });

  test("a $saved name nothing saved, or a save path the result lacks, fails the run", async () => {
    const server = mcpServer({ ticket_get: () => ({ data: { ticket: {} } }) });
    const unsaved = run(
      [{ tool: "ticket_get", args: { ticket: { $saved: "nope" } } }],
      { fetch: server.fetch },
    );
    expect((await untilTerminal(unsaved)).at(-1)).toMatchObject(
      failedWith('step 1 (ticket_get): no saved value "nope"'),
    );
    const missing = run(
      [{ tool: "ticket_get", args: {}, save: { v: "ticket.version" } }],
      { fetch: server.fetch },
    );
    expect((await untilTerminal(missing)).at(-1)).toMatchObject(
      failedWith("step 1 (ticket_get): nothing at ticket.version to save as v"),
    );
  });

  test("an expected refusal passes, and its reason is in the mcp_call event", async () => {
    const server = mcpServer({
      ticket_update: () => ({ refused: "cross_ticket_write" }),
    });
    const h = run(
      [
        {
          tool: "ticket_update",
          args: { ticket: "B", version: 1 },
          expect: { refused: "cross_ticket_write" },
        },
      ],
      { fetch: server.fetch },
    );
    const lines = await untilTerminal(h);
    expect(lines[1]).toMatchObject({
      kind: "mcp_call",
      payload: { outcome: "refused", reason: "cross_ticket_write" },
    });
    expect(lines.at(-1)).toMatchObject({ payload: { outcome: "ok" } });
  });

  test("an unmet expectation ends the run failed, naming the step and the path, and stops there", async () => {
    const server = mcpServer({
      ticket_get: () => ({ data: { ticket: { status: "doing" } } }),
      human_ask: () => ({ data: { status: "open" } }),
    });
    const h = run(
      [
        {
          tool: "ticket_get",
          args: { ticket: "A" },
          expect: { fields: { "ticket.status": "backlog" } },
        },
        { tool: "human_ask", args: {} },
      ],
      { fetch: server.fetch },
    );
    const lines = await untilTerminal(h);
    expect(lines.at(-1)).toMatchObject(
      failedWith(
        'step 1 (ticket_get): ticket.status is "doing", expected "backlog"',
      ),
    );
    expect(lines.filter((l) => l["kind"] === "mcp_call")).toHaveLength(1);
    expect(server.calls()).toHaveLength(1);
  });

  test("success where a refusal was expected, a refusal where success was, or another reason, fails", async () => {
    const cases: readonly [Reply, Steps[number]["expect"], string][] = [
      [
        { data: {} },
        { refused: "cross_ticket_write" },
        "expected a refusal (cross_ticket_write), got a result",
      ],
      [{ refused: "not_found" }, {}, "refused: not_found"],
      [
        { refused: "not_found" },
        { refused: "cross_ticket_write" },
        "refused: not_found, expected cross_ticket_write",
      ],
      [{ failed: "invalid arguments" }, {}, "failed: invalid arguments"],
    ];
    for (const [reply, expected, message] of cases) {
      const server = mcpServer({ ticket_update: () => reply });
      const h = run(
        [{ tool: "ticket_update", args: {}, expect: expected ?? {} }],
        { fetch: server.fetch },
      );
      expect((await untilTerminal(h)).at(-1)).toMatchObject(
        failedWith(`step 1 (ticket_update): ${message}`),
      );
    }
  });

  test("transport failures fail the run, and never print the token", async () => {
    const fetches: readonly [FixtureFetch, string][] = [
      [
        () => Promise.reject(new Error("connect ECONNREFUSED")),
        "connect ECONNREFUSED",
      ],
      [
        async () =>
          new Response("invalid or revoked session token", { status: 401 }),
        "HTTP 401: invalid or revoked session token",
      ],
      [
        async () =>
          json({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32601, message: "Method not found" },
          }),
        "JSON-RPC error -32601: Method not found",
      ],
      [async () => new Response("<html>", { status: 200 }), "not JSON"],
    ];
    for (const [fetch, message] of fetches) {
      const h = run([{ tool: "ticket_get", args: {} }], { fetch });
      expect((await untilTerminal(h)).at(-1)).toMatchObject(
        failedWith(message, "internal"),
      );
      expect(JSON.stringify(h.lines()) + h.stderr()).not.toContain(TOKEN);
    }
  });

  test("a tool the session does not mount is never called", async () => {
    const server = mcpServer({ ticket_update: () => ({ data: {} }) });
    const h = run([{ tool: "ticket_update", args: {} }], {
      fetch: server.fetch,
      tools: ["ticket_get"],
    });
    expect((await untilTerminal(h)).at(-1)).toMatchObject(
      failedWith(
        "step 1 (ticket_update): ticket_update is not one of this session's tools",
      ),
    );
    expect(server.seen).toEqual([]);
  });

  test("mcp steps without an MCP server, or without a token, fail the run", async () => {
    const steps = [{ tool: "ticket_get", args: {} }];
    const noServer = start({ script: { runs: [{ mcp: steps }] }, env });
    noServer.op(send);
    expect((await untilTerminal(noServer)).at(-1)).toMatchObject(
      failedWith("the script has mcp steps but the session has no MCP server"),
    );
    const noToken = run(steps, { env: {} });
    expect((await untilTerminal(noToken)).at(-1)).toMatchObject(
      failedWith(`no ${FIXTURE_MCP_TOKEN_ENV} in the environment`),
    );
  });

  test("a gated run holds after its mcp steps until release", async () => {
    const server = mcpServer({
      human_ask: () => ({ data: { status: "open" } }),
    });
    const h = start({
      script: {
        runs: [{ mcp: [{ tool: "human_ask", args: {} }], gate: "release" }],
      },
      mcp: { url: MCP_URL, tools: ["human_ask"] },
      env,
      fetch: server.fetch,
    });
    h.op(send);
    expect((await h.next())["kind"]).toBe("session_init");
    expect((await h.next())["kind"]).toBe("mcp_call");
    expect(h.lines().some((l) => l["kind"] === "terminal")).toBe(false);
    h.op({ op: "release" });
    expect(await h.next()).toMatchObject({
      kind: "terminal",
      payload: { outcome: "ok" },
    });
    h.eof();
    expect(await h.exit).toBe(0);
  });
});
