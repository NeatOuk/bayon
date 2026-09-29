// The fixture runner (§15): a scripted, reply-on-signal program that writes canonical events as
// JSON lines. Self-contained on purpose (no relative imports): the real child runs this very file
// (Node strips its types; from dist/ it runs the compiled .js), and FakeExecutor runs `runFixture`
// in-process. It never sleeps: it waits for stdin ops and exits on stdin EOF in every mode, so it
// dies with the supervisor (amendment 2). A run's `mcp` steps call the session's MCP server as
// plain JSON-RPC over fetch (M1 close), with the token from the environment, never printed.
import { GIT_ENV_FLOOR, safeGitArgs } from "@bayon/executors";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const STATE_FILE = "fixture-state.json";
/** Where the adapter puts the session's MCP token: the child's env, never argv or output. */
export const FIXTURE_MCP_TOKEN_ENV = "FRM_MCP_TOKEN";
/** The server name on `mcp_call` events. */
const MCP_SERVER = "foreman";
/** The protocol version initialize asks for; the server's answer rides on every later request. */
const MCP_PROTOCOL = "2025-06-18";

/** What an MCP step must get back: a refusal with this reason, else a result with these fields. */
const McpExpect = z.object({
  /** The refusal reason the call must come back with. Absent: the call must succeed. */
  refused: z.string().min(1).optional(),
  /** A refusal, whatever its reason, also meets the expectation; `fields` still check a result. */
  refusal_ok: z.boolean().default(false),
  /** Dotted paths into the result's JSON, each with the value it must equal. */
  fields: z.record(z.string(), z.json()).default({}),
});

/** One MCP tool call. Args pass an earlier step's saved value as `{"$saved": name}`. */
export const McpStep = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.json()).default({}),
  expect: McpExpect.prefault({}),
  /** Names for values in the result (dotted paths), for later steps' args. */
  save: z.record(z.string(), z.string().min(1)).default({}),
});
export type McpStep = z.infer<typeof McpStep>;

const Totals = z.object({
  tokens_in: z.int().nonnegative(),
  tokens_out: z.int().nonnegative(),
  tokens_cache_read: z.int().nonnegative(),
  tokens_cache_write: z.int().nonnegative(),
  cost_usd: z.number().nonnegative(),
});
type Totals = z.infer<typeof Totals>;

/** One run: what a `send` produces. */
export const FixtureRun = z.object({
  /** Canonical-event templates (no `ts`), written in order. Unknown kinds are allowed on purpose. */
  events: z.array(z.looseObject({ kind: z.string().min(1) })).default([]),
  /**
   * Text appended to files under the cwd before the events, so file changes are real. `tool` names
   * the tool making the change: a tool the spec denies (§15 #12) makes none.
   */
  appends: z
    .array(
      z.object({
        path: z.string().min(1),
        text: z.string(),
        tool: z.string().min(1).optional(),
      }),
    )
    .default([]),
  /**
   * After the appends, every change under the cwd is committed with this message (`git add -A`),
   * as a builder commits its work: a gate reviews HEAD, never the working tree. A failed commit
   * ends the run `failed`, before its events.
   */
  commit: z.string().min(1).optional(),
  /** MCP calls made after the events, in order; an unmet expectation ends the run `failed`. */
  mcp: z.array(McpStep).default([]),
  /** Events written once every MCP call met its expectation, e.g. the turns a call precedes. */
  events_after: z.array(z.looseObject({ kind: z.string().min(1) })).default([]),
  /** `release`: after the events and MCP calls, wait for `release` (or `interrupt`) before `then`. */
  gate: z.literal("release").optional(),
  /**
   * `terminal` ends the run; `hang` goes silent until interrupted (§15 #9); `hard_hang` also
   * ignores interrupt and SIGTERM; `crash` dies by SIGKILL; `exit0` exits 0 with the run open.
   */
  then: z
    .enum(["terminal", "hang", "hard_hang", "crash", "exit0"])
    .default("terminal"),
  /** Extra fields for the terminal payload, e.g. `{ "outcome": "failed" }`. */
  terminal: z.looseObject({}).optional(),
  /** What the run adds to the process's running totals. */
  spend: Totals.optional(),
});
export type FixtureRun = z.infer<typeof FixtureRun>;

export const FixtureScript = z.object({
  /** Run n uses `runs[n]`, or the last entry once the list runs out. */
  runs: z.array(FixtureRun).min(1),
  /**
   * Other run lists: the first whose `exists` path is under the cwd when the process starts is
   * used instead of `runs`. One profile then scripts a chain of sessions in one inherited
   * worktree, each finding what its predecessors left there.
   */
  variants: z
    .array(
      z.object({
        exists: z.string().min(1),
        runs: z.array(FixtureRun).min(1),
      }),
    )
    .default([]),
  /** Crash at once when started to resume, before any send. */
  crash_on_resume: z.boolean().default(false),
  model: z.string().min(1).default("fixture-model"),
});
export type FixtureScript = z.infer<typeof FixtureScript>;
export type FixtureScriptInput = z.input<typeof FixtureScript>;

/** What the adapter passes as `--spec <json>`. */
export const FixtureSpec = z.object({
  runnerSessionId: z.string().min(1),
  homeDir: z.string().min(1),
  resume: z.boolean(),
  script: FixtureScript,
  /** The session's MCP server and the tools it mounts; its token is in the env. */
  mcp: z.object({ url: z.url(), tools: z.array(z.string()) }).optional(),
  /** Tools the session denies (§15 #12): their appends are skipped, their results are errors. */
  deny: z.array(z.string()).default([]),
  /** SpawnSpec.builtinTools: `none` withholds the program's own (nominal) tools. */
  builtinTools: z.literal("none").optional(),
  /**
   * SpawnSpec.extraRoots: the only places besides the cwd an append may
   * land, reported in session_init as `extra_roots`.
   */
  extraRoots: z.array(z.string().min(1)).default([]),
});
export type FixtureSpec = z.infer<typeof FixtureSpec>;

/**
 * The program's own tools as session_init reports them: a nominal one, listed unless the spawn
 * withholds them, so a check on session_init sees the supervisor's intent end to end.
 */
export const FIXTURE_BUILTIN_TOOLS: readonly string[] = ["fixture.builtin"];

/** A denied tool's result comes back an error, as a runner's permission layer reports one. */
function deniedResult(
  event: Readonly<Record<string, unknown>>,
  deny: readonly string[],
): Readonly<Record<string, unknown>> {
  const tool = event["tool_name"];
  if (
    event["kind"] !== "tool_result" ||
    typeof tool !== "string" ||
    !deny.includes(tool)
  )
    return event;
  const payload = event["payload"];
  return {
    ...event,
    status: "error",
    payload: {
      ...(typeof payload === "object" && payload !== null ? payload : {}),
      denied: true,
    },
  };
}

const SavedState = z.object({
  runnerSessionId: z.string(),
  runIndex: z.int().nonnegative(),
  eventIndex: z.int().nonnegative(),
});

const DEFAULT_RUN_SPEND: Totals = {
  tokens_in: 100,
  tokens_out: 20,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd: 0.001,
};

/** One real README edit and the Done-when sequence, plus an unknown kind (§15 #10). */
export const DEFAULT_SCRIPT: FixtureScript = FixtureScript.parse({
  runs: [
    {
      appends: [{ path: "README.md", text: "fixture was here\n" }],
      events: [
        { kind: "turn_start", runner_type: "fixture.step", payload: {} },
        {
          kind: "tool_call",
          runner_type: "fixture.tool",
          tool_name: "edit",
          payload: { call_id: "call-1", input: { path: "README.md" } },
        },
        {
          kind: "tool_result",
          runner_type: "fixture.tool",
          tool_name: "edit",
          status: "ok",
          payload: { call_id: "call-1" },
        },
        {
          kind: "file_change",
          runner_type: "fixture.tool",
          payload: {
            path: "README.md",
            change: "modify",
            lines_added: 1,
            lines_removed: 0,
          },
        },
        { kind: "zz_unknown", runner_type: "fixture.unknown", payload: {} },
        {
          kind: "turn_end",
          runner_type: "fixture.step",
          payload: {
            usage: {
              tokens_in: 100,
              tokens_out: 20,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
            },
            stop_reason: "end_turn",
          },
        },
      ],
    },
  ],
});

/** Plain fetch, as the program calls it: the real one, or a test's fake server. */
export type FixtureFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** What the program needs from its host: a real process, or FakeExecutor's in-process io. */
export interface FixtureIo {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The process environment: where the MCP token is. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: FixtureFetch;
  readonly stdin: AsyncIterable<Uint8Array>;
  readonly stdout: { write(chunk: string): void };
  readonly stderr: { write(chunk: string): void };
  /** Dies at once: SIGKILL on a real process. */
  crash(): Promise<number>;
  /** Makes SIGTERM harmless: a real process only; in-process every signal is fatal. */
  ignoreTerm(): void;
}

const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("send"), runId: z.string(), text: z.string() }),
  z.object({ op: z.literal("release") }),
  z.object({ op: z.literal("interrupt") }),
]);
type Op = z.infer<typeof Op>;

async function* ops(stdin: AsyncIterable<Uint8Array>): AsyncGenerator<Op> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stdin) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split(
      "\n",
    );
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const op = Op.safeParse(safeJson(line));
      if (op.success) yield op.data;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const addTotals = (a: Totals, b: Totals): Totals => ({
  tokens_in: a.tokens_in + b.tokens_in,
  tokens_out: a.tokens_out + b.tokens_out,
  tokens_cache_read: a.tokens_cache_read + b.tokens_cache_read,
  tokens_cache_write: a.tokens_cache_write + b.tokens_cache_write,
  cost_usd: Math.round((a.cost_usd + b.cost_usd) * 1e9) / 1e9,
});
const NO_SPEND: Totals = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  cost_usd: 0,
};

type Open = {
  readonly run: FixtureRun;
  readonly gated: boolean;
  readonly mode: "running" | "hang" | "hard_hang";
};

/** Why an MCP step failed its run: the terminal's `error`. Never carries the token. */
type McpFailure = {
  readonly class: "validation" | "internal";
  readonly message: string;
};
type Got<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: McpFailure };
const got = <T>(value: T): Got<T> => ({ ok: true, value });
const lost = (cls: McpFailure["class"], message: string): Got<never> => ({
  ok: false,
  error: { class: cls, message },
});

const RpcReply = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});
const InitializeResult = z.looseObject({ protocolVersion: z.string().min(1) });
const CallResult = z.object({
  content: z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .default([]),
  isError: z.boolean().optional(),
  structuredContent: z
    .looseObject({
      refused: z.boolean().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});
type CallOutcome =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "failed"; readonly text: string };

function outcomeOf(r: z.infer<typeof CallResult>): CallOutcome {
  const text = r.content.map((c) => c.text ?? "").join("\n");
  if (r.isError !== true) return { kind: "ok", data: safeJson(text) ?? text };
  const reason = r.structuredContent?.reason;
  return r.structuredContent?.refused === true && reason !== undefined
    ? { kind: "refused", reason }
    : { kind: "failed", text };
}

/** A stateless MCP client over plain fetch: initialize once, then tools/call. */
function mcpClient(url: string, token: string, fetcher: FixtureFetch) {
  let protocol: string | undefined;
  let id = 0;
  // Belt and braces: whatever a server echoes back, the token never reaches an event or a log.
  const fail = (message: string): Got<never> =>
    lost("internal", message.split(token).join("[token]"));
  const post = async (body: object): Promise<Got<Response>> => {
    try {
      return got(
        await fetcher(url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            ...(protocol === undefined
              ? {}
              : { "mcp-protocol-version": protocol }),
          },
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
  const request = async (
    method: string,
    params: object,
  ): Promise<Got<unknown>> => {
    id += 1;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) return res;
    const text = await res.value.text().catch(() => "");
    if (!res.value.ok)
      return fail(`${method}: HTTP ${res.value.status}: ${text.slice(0, 200)}`);
    const reply = RpcReply.safeParse(safeJson(text));
    if (!reply.success)
      return fail(`${method}: the reply is not JSON-RPC (not JSON?)`);
    const e = reply.data.error;
    return e === undefined
      ? got(reply.data.result)
      : fail(`${method}: JSON-RPC error ${e.code}: ${e.message}`);
  };
  const initialize = async (): Promise<Got<void>> => {
    const result = await request("initialize", {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    if (!result.ok) return result;
    const init = InitializeResult.safeParse(result.value);
    if (!init.success)
      return fail("initialize: no protocolVersion in the reply");
    protocol = init.data.protocolVersion;
    const note = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    if (!note.ok) return note;
    await note.value.text().catch(() => "");
    return note.value.ok
      ? got(undefined)
      : fail(`notifications/initialized: HTTP ${note.value.status}`);
  };
  return {
    async call(name: string, args: unknown): Promise<Got<CallOutcome>> {
      if (protocol === undefined) {
        const init = await initialize();
        if (!init.ok) return init;
      }
      const result = await request("tools/call", { name, arguments: args });
      if (!result.ok) return result;
      const parsed = CallResult.safeParse(result.value);
      return parsed.success
        ? got(outcomeOf(parsed.data))
        : fail("tools/call: the reply is not a tool result");
    },
  };
}

/** The value at a dotted path (array indexes included), or undefined. */
function at(value: unknown, path: string): unknown {
  let here: unknown = value;
  for (const key of path.split(".")) {
    if (typeof here !== "object" || here === null) return undefined;
    here = (here as Readonly<Record<string, unknown>>)[key];
  }
  return here;
}

const show = (value: unknown): string =>
  value === undefined ? "missing" : JSON.stringify(value);

/** `value` with each `{"$saved": name}` replaced by that saved value. */
function resolveArgs(
  value: unknown,
  saved: ReadonlyMap<string, unknown>,
): Got<unknown> {
  if (typeof value !== "object" || value === null) return got(value);
  const entries = Object.entries(value);
  const [only] = entries;
  if (
    entries.length === 1 &&
    only?.[0] === "$saved" &&
    typeof only[1] === "string"
  ) {
    return saved.has(only[1])
      ? got(saved.get(only[1]))
      : lost("validation", `no saved value "${only[1]}"`);
  }
  const resolved: [string, unknown][] = [];
  for (const [key, inner] of entries) {
    const r = resolveArgs(inner, saved);
    if (!r.ok) return r;
    resolved.push([key, r.value]);
  }
  return got(
    Array.isArray(value)
      ? resolved.map(([, v]) => v)
      : Object.fromEntries(resolved),
  );
}

/** What is wrong with a call's outcome against its step's expectation; undefined when met. */
function unmet(
  outcome: CallOutcome,
  expect: McpStep["expect"],
): string | undefined {
  if (expect.refusal_ok && outcome.kind === "refused") return undefined;
  if (expect.refused !== undefined) {
    if (outcome.kind === "refused")
      return outcome.reason === expect.refused
        ? undefined
        : `refused: ${outcome.reason}, expected ${expect.refused}`;
    return outcome.kind === "ok"
      ? `expected a refusal (${expect.refused}), got a result`
      : `failed: ${outcome.text}`;
  }
  if (outcome.kind === "refused") return `refused: ${outcome.reason}`;
  if (outcome.kind === "failed") return `failed: ${outcome.text}`;
  for (const [path, want] of Object.entries(expect.fields)) {
    const seen = at(outcome.data, path);
    if (!isDeepStrictEqual(seen, want))
      return `${path} is ${show(seen)}, expected ${show(want)}`;
  }
  return undefined;
}

/** `saved` plus the values the step names from its result. */
function saveFrom(
  outcome: CallOutcome,
  save: Readonly<Record<string, string>>,
  saved: ReadonlyMap<string, unknown>,
): Got<ReadonlyMap<string, unknown>> {
  const data = outcome.kind === "ok" ? outcome.data : undefined;
  const next = new Map(saved);
  for (const [name, path] of Object.entries(save)) {
    const value = at(data, path);
    if (value === undefined)
      return lost("validation", `nothing at ${path} to save as ${name}`);
    next.set(name, value);
  }
  return got(next);
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * A run's MCP steps, in order, one `mcp_call` event per call made. Resolves to why the run fails,
 * or undefined once every expectation is met.
 */
/**
 * A fixed identity and no signing: the same commit on a bare CI machine and a laptop. The rest of
 * the flags are safeGitArgs and GIT_ENV_FLOOR, applied where this runs git.
 */
const COMMIT_FLAGS = [
  "-c",
  "user.name=frm fixture",
  "-c",
  "user.email=fixture@frm.invalid",
  "-c",
  "commit.gpgsign=false",
];

/** A path's real path, or the path itself when it does not exist (yet). */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The root an append lands in (L5): the cwd or an extra root, judged by the real path of the
 * file's directory and path.relative (never a string prefix), so `..` or a symlink out is caught.
 */
function rootOf(
  cwd: string,
  extraRoots: readonly string[],
  target: string,
): string | undefined {
  const parent = realOrSelf(dirname(target));
  return [cwd, ...extraRoots].find((root) => {
    const rel = relative(realOrSelf(root), parent);
    return (
      rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    );
  });
}

/** A run's appends, each inside a root; the roots written to, or why one was refused. */
function appendAll(
  cwd: string,
  extraRoots: readonly string[],
  run: FixtureRun,
  deny: readonly string[],
): { readonly roots: string[] } | { readonly failure: McpFailure } {
  const roots: string[] = [];
  for (const a of run.appends) {
    if (a.tool !== undefined && deny.includes(a.tool)) continue;
    const target = resolve(cwd, a.path);
    const root = rootOf(cwd, extraRoots, target);
    if (root === undefined) {
      return {
        failure: {
          class: "validation",
          message: `append ${a.path} lands outside the session's roots`,
        },
      };
    }
    appendFileSync(target, a.text);
    if (!roots.includes(root)) roots.push(root);
  }
  return { roots };
}

/** commitAll in the cwd, then in each extra root that received appends; the first failure. */
function commitRoots(
  io: FixtureIo,
  roots: readonly string[],
  message: string,
): McpFailure | undefined {
  for (const root of [io.cwd, ...roots.filter((r) => r !== io.cwd)]) {
    const failed = commitAll(io, root, message);
    if (failed !== undefined) return failed;
  }
  return undefined;
}

/** `git add -A` and one commit in `cwd`; the failure, if any. Git runs as argv, never a shell. */
function commitAll(
  io: FixtureIo,
  cwd: string,
  message: string,
): McpFailure | undefined {
  const env = {
    ...GIT_ENV_FLOOR,
    PATH: io.env["PATH"] ?? "/usr/bin:/bin",
  };
  const git = (args: readonly string[]) =>
    execFileSync("git", safeGitArgs([...COMMIT_FLAGS, ...args]), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
    return undefined;
  } catch (e) {
    const stderr =
      typeof e === "object" && e !== null && "stderr" in e
        ? String(e.stderr).trim()
        : "";
    return {
      class: "internal",
      message: `commit: ${stderr || (e instanceof Error ? e.message : String(e))}`,
    };
  }
}

async function runMcpSteps(
  steps: readonly McpStep[],
  server: FixtureSpec["mcp"],
  io: FixtureIo,
  emit: (event: Readonly<Record<string, unknown>>) => void,
): Promise<McpFailure | undefined> {
  if (steps.length === 0) return undefined;
  if (server === undefined)
    return {
      class: "validation",
      message: "the script has mcp steps but the session has no MCP server",
    };
  const token = io.env[FIXTURE_MCP_TOKEN_ENV];
  if (token === undefined || token === "")
    return {
      class: "validation",
      message: `no ${FIXTURE_MCP_TOKEN_ENV} in the environment`,
    };
  const client = mcpClient(server.url, token, io.fetch);
  let saved: ReadonlyMap<string, unknown> = new Map();
  for (const [i, step] of steps.entries()) {
    const failed = (f: McpFailure): McpFailure => ({
      ...f,
      message: `step ${i + 1} (${step.tool}): ${f.message}`,
    });
    if (!server.tools.includes(step.tool))
      return failed({
        class: "validation",
        message: `${step.tool} is not one of this session's tools`,
      });
    const args = resolveArgs(step.args, saved);
    if (!args.ok) return failed(args.error);
    const outcome = await client.call(step.tool, args.value);
    if (!outcome.ok) return failed(outcome.error);
    const o = outcome.value;
    emit({
      kind: "mcp_call",
      runner_type: "fixture.mcp",
      tool_name: step.tool,
      payload: {
        server: MCP_SERVER,
        args_digest: sha256(JSON.stringify(args.value)),
        outcome: o.kind,
        ...(o.kind === "refused" ? { reason: o.reason } : {}),
      },
    });
    const wrong = unmet(o, step.expect);
    if (wrong !== undefined)
      return failed({ class: "validation", message: wrong });
    // A tolerated refusal has no result to save from: later steps keep what was saved before.
    const next =
      o.kind === "refused" && step.expect.refusal_ok
        ? got(saved)
        : saveFrom(o, step.save, saved);
    if (!next.ok) return failed(next.error);
    saved = next.value;
  }
  return undefined;
}

/** Runs the fixture until stdin ends (or the script exits or crashes); resolves to the exit code. */
export async function runFixture(io: FixtureIo): Promise<number> {
  const at = io.argv.indexOf("--spec");
  const parsed = FixtureSpec.safeParse(safeJson(io.argv[at + 1] ?? ""));
  if (at === -1 || !parsed.success) {
    io.stderr.write("fixture: missing or invalid --spec\n");
    return 2;
  }
  const {
    runnerSessionId,
    homeDir,
    resume,
    script,
    mcp,
    deny,
    builtinTools,
    extraRoots,
  } = parsed.data;
  const statePath = join(homeDir, STATE_FILE);
  const stateTmp = `${statePath}.tmp`;
  const runs =
    script.variants.find((v) => existsSync(resolve(io.cwd, v.exists)))?.runs ??
    script.runs;

  let runIndex = 0;
  if (resume) {
    if (script.crash_on_resume) return io.crash();
    const saved = SavedState.safeParse(safeJson(readText(statePath) ?? ""));
    if (!saved.success || saved.data.runnerSessionId !== runnerSessionId) {
      io.stderr.write(`fixture: no state to resume ${runnerSessionId}\n`);
      return 3;
    }
    // A run cut off mid-way is abandoned: the next send starts the next run.
    runIndex = saved.data.runIndex + (saved.data.eventIndex > 0 ? 1 : 0);
  }

  let eventIndex = 0;
  let initDone = false;
  let open: Open | undefined;
  let cumulative = NO_SPEND;

  // Whole or not at all: a kill -9 lands anywhere, inside a save too (§15 #8 kills right after a
  // run's tool_call is out, as its save runs). Written in place, a kill between the truncate and the
  // write left the file empty and the resume refused; a rename keeps the last whole state.
  const save = () => {
    writeFileSync(
      stateTmp,
      JSON.stringify({ runnerSessionId, runIndex, eventIndex }),
    );
    renameSync(stateTmp, statePath);
  };
  const emit = (event: Readonly<Record<string, unknown>>) => {
    io.stdout.write(`${JSON.stringify(event)}\n`);
    eventIndex += 1;
    save();
  };
  const endRun = (payload: Readonly<Record<string, unknown>>) => {
    emit({
      kind: "terminal",
      runner_type: "fixture.terminal",
      payload: {
        outcome: "ok",
        ...payload,
        cumulative: { [script.model]: cumulative },
      },
    });
    open = undefined;
    runIndex += 1;
    eventIndex = 0;
    save();
  };
  /** Carries out a run's `then`; a number is an exit code. */
  const proceed = (run: FixtureRun): Promise<number> | number | undefined => {
    switch (run.then) {
      case "terminal":
        cumulative = addTotals(cumulative, run.spend ?? DEFAULT_RUN_SPEND);
        endRun(run.terminal ?? {});
        return undefined;
      case "hang":
        open = { run, gated: false, mode: "hang" };
        return undefined;
      case "hard_hang":
        io.ignoreTerm();
        open = { run, gated: false, mode: "hard_hang" };
        return undefined;
      case "crash":
        return io.crash();
      case "exit0":
        return 0;
    }
  };

  for await (const op of ops(io.stdin)) {
    let exit: Promise<number> | number | undefined;
    if (op.op === "send" && open === undefined) {
      const run =
        runs[Math.min(runIndex, runs.length - 1)] ?? DEFAULT_SCRIPT.runs[0];
      if (run === undefined) return 2;
      if (!initDone) {
        initDone = true;
        emit({
          kind: "session_init",
          runner_type: "fixture.init",
          payload: {
            runner_session_id: runnerSessionId,
            model: script.model,
            mcp_tools: mcp?.tools ?? [],
            builtin_tools:
              builtinTools === "none" ? [] : [...FIXTURE_BUILTIN_TOOLS],
            ...(extraRoots.length > 0 ? { extra_roots: extraRoots } : {}),
          },
        });
      }
      const appended = appendAll(io.cwd, extraRoots, run, deny);
      open = { run, gated: run.gate === "release", mode: "running" };
      const uncommitted =
        "failure" in appended
          ? appended.failure
          : run.commit === undefined
            ? undefined
            : commitRoots(io, appended.roots, run.commit);
      if (uncommitted === undefined)
        for (const event of run.events) emit(deniedResult(event, deny));
      const failure =
        uncommitted ?? (await runMcpSteps(run.mcp, mcp, io, emit));
      if (failure !== undefined) {
        cumulative = addTotals(cumulative, run.spend ?? DEFAULT_RUN_SPEND);
        endRun({ outcome: "failed", error: { ...failure, retryable: false } });
      } else {
        for (const event of run.events_after) emit(event);
        if (run.gate !== "release") exit = proceed(run);
      }
    } else if (op.op === "release" && open?.gated === true) {
      open = { ...open, gated: false };
      exit = proceed(open.run);
    } else if (
      op.op === "interrupt" &&
      open !== undefined &&
      open.mode !== "hard_hang"
    ) {
      endRun({ outcome: "interrupted" });
    }
    if (exit !== undefined) return exit;
  }
  return 0;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
  );
}

if (isMain()) {
  const code = await runFixture({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    stdin: process.stdin,
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
    stderr: { write: (chunk) => void process.stderr.write(chunk) },
    crash: () => {
      process.kill(process.pid, "SIGKILL");
      return new Promise<number>(() => {});
    },
    ignoreTerm: () => void process.on("SIGTERM", () => {}),
  });
  process.stdout.write("", () => process.exit(code));
}
