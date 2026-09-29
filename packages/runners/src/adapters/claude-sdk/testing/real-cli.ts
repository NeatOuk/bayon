// What the tests that run the real bundled CLI share: a local stand-in for the Messages
// API, one turn through the adapter, and one run of the bare binary. The stand-in records every
// request and answers each with one streamed turn: "ok", or, when the prompt is ECHO_PROMPT (or
// ENV_PROMPT) and the CLI offers its Bash tool, first a Bash call that echoes FRM_TEST_FROM_REPO (or
// runs `env`), then "ok" once the tool result comes back. No model call, no spend: nothing leaves
// 127.0.0.1.
import { execFile } from "node:child_process";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { SpawnSpec } from "../../../adapter.js";
import {
  createClaudeSdkAdapter,
  type ClaudeSdkAdapterOptions,
} from "../adapter.js";
import { MODELS } from "../registration.js";

export const MODEL = MODELS.find((m) => m.tier === "cheap")?.model ?? "";
/** The dummy key every such test runs on: never a real credential, never the Keychain. */
export const KEY = "sk-test-dummy";
/** Nothing but the API call: no updater, no telemetry, no error reports. */
export const QUIET = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
};
/** The prompt that gets a Bash call; the variable is what a repo's settings env would set. */
export const ECHO_PROMPT = "Echo FRM_TEST_FROM_REPO with your Bash tool.";
export const ECHO_COMMAND = 'echo "repo=[$FRM_TEST_FROM_REPO]"';
/** The prompt whose Bash call prints the model shell's whole env. */
export const ENV_PROMPT = "Print your shell's environment with your Bash tool.";
export const ENV_COMMAND = "env";
/** Each prompt that gets a Bash call, and the command it gets. */
const BASH_CALLS: readonly (readonly [string, string])[] = [
  [ECHO_PROMPT, ECHO_COMMAND],
  [ENV_PROMPT, ENV_COMMAND],
];

export type Hit = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
};

export type StandIn = { readonly server: Server; readonly url: string };

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly name: string;
      readonly input: object;
    };

type Request = {
  readonly stream?: boolean;
  readonly tools?: readonly {
    readonly name?: string;
    readonly defer_loading?: boolean;
  }[];
  readonly messages?: readonly { readonly content?: unknown }[];
};

const parse = (body: string): Request => {
  try {
    return JSON.parse(body) as Request;
  } catch {
    return {}; // not JSON: answered as a plain reply
  }
};

const hasToolResult = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.some(
    (b: unknown) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "tool_result",
  );

/** The reply this request gets: a Bash call only for a BASH_CALLS prompt, only once. */
function blocksFor(request: Request, body: string): Block[] {
  const last = request.messages?.at(-1);
  const offersBash = (request.tools ?? []).some((t) => t.name === "Bash");
  const command = BASH_CALLS.find(([prompt]) => body.includes(prompt))?.[1];
  if (offersBash && command !== undefined && !hasToolResult(last?.content)) {
    return [
      {
        type: "tool_use",
        name: "Bash",
        input: { command, description: "run" },
      },
    ];
  }
  return [{ type: "text", text: "ok" }];
}

function streamEvents(blocks: readonly Block[]): [string, object][] {
  const events: [string, object][] = [];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        [
          "content_block_start",
          { index, content_block: { type: "text", text: "" } },
        ],
        [
          "content_block_delta",
          { index, delta: { type: "text_delta", text: block.text } },
        ],
      );
    } else {
      events.push(
        [
          "content_block_start",
          {
            index,
            content_block: {
              type: "tool_use",
              id: `toolu_standin_${index}`,
              name: block.name,
              input: {},
            },
          },
        ],
        [
          "content_block_delta",
          {
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          },
        ],
      );
    }
    events.push(["content_block_stop", { index }]);
  });
  return events;
}

/** Just enough of the Messages API for one turn: a streamed reply, or a plain one. */
function answer(body: string, res: ServerResponse): void {
  const request = parse(body);
  const message = {
    id: "msg_standin",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  if (request.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...message,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
    );
    return;
  }
  const blocks = blocksFor(request, body);
  const stop = blocks.some((b) => b.type === "tool_use")
    ? "tool_use"
    : "end_turn";
  const events: [string, object][] = [
    ["message_start", { message: { ...message, content: [] } }],
    ...streamEvents(blocks),
    [
      "message_delta",
      {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", {}],
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [type, data] of events) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  }
  res.end();
}

/** A local server that records every request into `hits` and answers the Messages API. */
export async function standIn(hits: Hit[]): Promise<StandIn> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const url = req.url ?? "";
      hits.push({ method: req.method ?? "", url, headers: req.headers, body });
      if (
        req.method === "POST" &&
        url.includes("/v1/messages") &&
        !url.includes("count_tokens")
      ) {
        answer(body, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the stand-in has no port");
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export const closeStandIn = (s: StandIn | undefined): Promise<void> =>
  s === undefined
    ? Promise.resolve()
    : new Promise<void>((resolve) => s.server.close(() => resolve()));

export const isMessages = (hit: Hit): boolean =>
  hit.method === "POST" && hit.url.includes("/v1/messages");

/** The main loop's requests: the ones that offer the Bash tool. */
export const mainLoop = (hits: readonly Hit[]): Hit[] =>
  hits.filter(
    (hit) =>
      isMessages(hit) &&
      (parse(hit.body).tools ?? []).some((t) => t.name === "Bash"),
  );

/**
 * The tools a request offers: every name in order (a deferred one marked `*`), how many are
 * deferred, and the bytes of the tools array and of the whole body.
 */
export function toolsOf(hit: Hit): {
  readonly names: readonly string[];
  readonly deferred: number;
  readonly toolBytes: number;
  readonly bodyBytes: number;
} {
  const tools = parse(hit.body).tools ?? [];
  return {
    names: tools.map(
      (t) => `${t.name ?? "?"}${t.defer_loading === true ? "*" : ""}`,
    ),
    deferred: tools.filter((t) => t.defer_loading === true).length,
    toolBytes: Buffer.byteLength(JSON.stringify(tools)),
    bodyBytes: Buffer.byteLength(hit.body),
  };
}

/** A request's system prompt, as one string. */
export const systemOf = (hit: Hit): string =>
  JSON.stringify((JSON.parse(hit.body) as { system?: unknown }).system ?? "");

/** A request's messages, as one string. */
export const messagesOf = (hit: Hit): string =>
  JSON.stringify(parse(hit.body).messages ?? []);

/** Every tool result the CLI sent back, as JSON text. */
export const toolResults = (hits: readonly Hit[]): string[] =>
  hits.flatMap((hit) =>
    (parse(hit.body).messages ?? []).flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.flatMap((b: unknown) =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "tool_result"
              ? [JSON.stringify((b as { content?: unknown }).content)]
              : [],
          )
        : [],
    ),
  );

/** Real processes run on real time: a deadline, never a sleep. */
export async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline passed: ${what}`)),
          60_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One turn through the adapter on the real CLI: the run's outcome and the process's stderr tail. */
export async function oneTurn(
  spec: SpawnSpec,
  text: string,
  options: ClaudeSdkAdapterOptions = {},
): Promise<{ readonly outcome: unknown; readonly stderrTail: string }> {
  const adapter = createClaudeSdkAdapter(options);
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
  const home = await adapter.prepareHome(spec);
  if (!home.ok) throw new Error(home.error.message);
  const spawned = await adapter.spawn(spec, local);
  if (!spawned.ok) throw new Error(spawned.error.message);
  const h = spawned.value;
  let outcome: unknown;
  try {
    const records = adapter.records(h)[Symbol.asyncIterator]();
    const mapper = adapter.createMapper({ prices: MODELS });
    const sent = await adapter.send(h, {
      runId: `${spec.sessionId}-1`,
      text,
      promptPath: `/${spec.sessionId}/run-1.md`,
    });
    if (!sent.ok) throw new Error(sent.error.message);
    let offset = 0;
    while (outcome === undefined) {
      const next = await within(records.next(), "the next record");
      if (next.done === true) break;
      const events = mapper.map({
        offset,
        bytes: next.value.bytes,
        ts: Date.now(),
        partial: next.value.partial,
      });
      offset += next.value.bytes.length + 1;
      outcome = events.find((e) => e.kind === "terminal")?.payload["outcome"];
    }
  } finally {
    await within(adapter.stop(h, "graceful"), "graceful stop");
  }
  return { outcome, stderrTail: (await h.exited).stderrTail };
}

/** The bare binary, `-p`, stdin closed at once; resolves with its stderr. Its exit is not evidence. */
export async function runCli(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return (await runCliOutput(binary, args, cwd, env)).stderr;
}

/** `runCli`, with its stdout too: `--output-format json` puts the result frame there. */
export function runCliOutput(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      [...args],
      { cwd, env, timeout: 60_000 },
      (_error, stdout, stderr) =>
        resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
    child.stdin?.end();
  });
}
