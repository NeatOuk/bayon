// Structured output on the real SDK and the stub CLI, no key: the spawn's schema reaches
// the CLI as --json-schema, the answer lands at SendSpec.output.path before its terminal can be
// read, and a run that owed an answer and gave none is a typed failure with no file.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_OUTPUT_JSON_SCHEMA } from "@bayon/core";
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type Executor,
} from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { DEFAULTS, MODELS } from "./registration.js";
import {
  OUTPUT_WARNING,
  OutputSlot,
  outputFormatFor,
  outputTarget,
  resultFrameOf,
} from "./structured-output.js";
import { STRUCTURED_OUTPUT_TOOL } from "./tool-names.js";

const STUB = fileURLToPath(new URL("./testing/stub-cli.mjs", import.meta.url));
const SCHEMA = REVIEW_OUTPUT_JSON_SCHEMA;
const OUTPUT = { schema: SCHEMA };
/** What the CLI is handed: core's schema without its 2020-12 `$schema`, which it cannot resolve. */
const { $schema: DECLARED, ...STRIPPED } = SCHEMA as Record<string, unknown>;

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-so-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(8) });
const adapter = createClaudeSdkAdapter({
  pathToExecutable: STUB,
  executable: "node",
});

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`deadline passed: ${what}`)),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let sessions = 0;
function spec(
  env: Record<string, string> = {},
  extra: Partial<SpawnSpec> = {},
): SpawnSpec {
  const base = join(root, `s${++sessions}`);
  const cwd = join(base, "work");
  const homeDir = join(base, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(base, "output"), { recursive: true });
  return {
    sessionId: `01STRUCTURED${sessions}`,
    cwd,
    homeDir,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
    ...extra,
  };
}
const outputPath = (s: SpawnSpec) =>
  join(s.homeDir, "..", "output", "run-1.json");

async function spawned(s: SpawnSpec, ex: Executor = local) {
  const r = await within(adapter.spawn(s, ex), "spawn");
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return r.value;
}
const argvOf = (s: SpawnSpec): string[] =>
  JSON.parse(readFileSync(join(s.homeDir, "argv.json"), "utf8")) as string[];

/** Events up to and including the run's terminal; `seen` runs when that record is read. */
async function runEvents(
  h: SessionHandle,
  seen: () => void = () => undefined,
): Promise<MappedEvent[]> {
  const records: AsyncIterable<RawRecord> = adapter.records(h);
  const mapper = adapter.createMapper({ prices: MODELS });
  const out: MappedEvent[] = [];
  let offset = 0;
  for await (const r of records) {
    const events = mapper.map({ offset, bytes: r.bytes, ts: 1 });
    offset += r.bytes.length + 1;
    out.push(...events);
    if (events.some((e) => e.kind === "terminal")) {
      seen();
      return out;
    }
  }
  return out;
}

const review = (h: SessionHandle, path?: string) =>
  adapter.send(h, {
    runId: "run-1",
    text: "Review the file add.js in the current directory for bugs.",
    promptPath: "/prompts/run-1.md",
    ...(path === undefined ? {} : { output: { schema: SCHEMA, path } }),
  });

/** argv with the schema pair and the answer tool's allow taken out, and the session id masked. */
function lessStructured(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--json-schema") {
      i += 1;
      continue;
    }
    if (a === "--allowedTools") {
      const kept = (argv[i + 1] ?? "")
        .split(",")
        .filter((t) => t !== STRUCTURED_OUTPUT_TOOL);
      i += 1;
      if (kept.length > 0) out.push(a, kept.join(","));
      continue;
    }
    out.push(a.startsWith("--session-id=") ? "--session-id=<id>" : a);
  }
  return out;
}

describe(
  "structured output through the SDK's outputFormat",
  { timeout: 60_000 },
  () => {
    test("the spawn's schema goes to the CLI as --json-schema, without $schema, and the answer tool is allowed", async () => {
      const s = spec({}, { output: OUTPUT });
      const h = await spawned(s);
      const argv = argvOf(s);
      const at = argv.indexOf("--json-schema");
      expect(at).toBeGreaterThan(-1);
      expect(DECLARED).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(JSON.parse(argv[at + 1] ?? "null")).toEqual(STRIPPED);
      expect(argv[argv.indexOf("--allowedTools") + 1]?.split(",")).toContain(
        STRUCTURED_OUTPUT_TOOL,
      );
      await within(adapter.stop(h, "graceful"), "stop");
    });

    test("structured_output lands in SendSpec.output.path, at 0600, before the run's terminal can be read", async () => {
      const s = spec({}, { output: OUTPUT });
      const h = await spawned(s);
      const path = outputPath(s);
      expect((await review(h, path)).ok).toBe(true);
      let onDisk = false;
      const events = await runEvents(h, () => {
        onDisk = existsSync(path);
      });
      expect(onDisk).toBe(true);
      expect(events.at(-1)).toMatchObject({
        kind: "terminal",
        payload: { outcome: "ok" },
      });
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        findings: [
          expect.objectContaining({ file: "add.js", severity: "major" }),
        ],
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      await within(adapter.stop(h, "graceful"), "stop");
    });

    test("no output: no --json-schema, and argv is the schema session's less exactly that pair and the allow", async () => {
      const shared = spec();
      const plain = await spawned(shared);
      const without = argvOf(shared);
      await within(adapter.stop(plain, "graceful"), "stop");
      const structured = await spawned({ ...shared, output: OUTPUT });
      const withSchema = argvOf(shared);
      await within(adapter.stop(structured, "graceful"), "stop");

      expect(without).not.toContain("--json-schema");
      expect(without.join(" ")).not.toContain(STRUCTURED_OUTPUT_TOOL);
      expect(withSchema).toContain("--json-schema");
      expect(lessStructured(withSchema)).toEqual(lessStructured(without));
    });

    test("a success without structured_output is terminal{failed, runner_error}, and no file is written", async () => {
      const s = spec({ FRM_STUB_STRUCTURED: "missing" }, { output: OUTPUT });
      const h = await spawned(s);
      expect((await review(h, outputPath(s))).ok).toBe(true);
      const events = await runEvents(h);
      expect(events.at(-1)).toMatchObject({
        kind: "terminal",
        payload: {
          outcome: "failed",
          error: {
            class: "runner_error",
            message: "the run ended without its structured output",
          },
        },
      });
      expect(existsSync(outputPath(s))).toBe(false);
      await within(adapter.stop(h, "graceful"), "stop");
    });

    test("retry exhaustion ends the run on a terminal{failed, runner_error}, and no file is written", async () => {
      const s = spec({ FRM_STUB_STRUCTURED: "exhausted" }, { output: OUTPUT });
      const h = await spawned(s);
      expect((await review(h, outputPath(s))).ok).toBe(true);
      const events = await runEvents(h);
      expect(events.at(-1)).toMatchObject({
        kind: "terminal",
        payload: {
          outcome: "failed",
          terminal_reason: "structured_output_retry_exhausted",
          error: {
            class: "runner_error",
            message: expect.stringContaining("retries ran out"),
            retryable: false,
          },
        },
      });
      expect(existsSync(outputPath(s))).toBe(false);
      // The session is still usable: the next send opens a run.
      expect((await review(h)).ok).toBe(true);
      await within(adapter.stop(h, "kill"), "kill");
    });

    test("a write that fails is warned with its path, leaves no file, and the run still ends", async () => {
      const s = spec({}, { output: OUTPUT });
      const h = await spawned(s);
      const path = join(root, "no-such-dir", "run-1.json");
      const warnings: Error[] = [];
      const listener = (w: Error) => warnings.push(w);
      process.on("warning", listener);
      try {
        expect((await review(h, path)).ok).toBe(true);
        expect((await runEvents(h)).at(-1)?.kind).toBe("terminal");
        await expect
          .poll(() => warnings.filter((w) => w.name === OUTPUT_WARNING))
          .toHaveLength(1);
      } finally {
        process.off("warning", listener);
      }
      const [warning] = warnings.filter((w) => w.name === OUTPUT_WARNING);
      expect(warning?.message).toContain(path);
      expect(existsSync(path)).toBe(false);
      await within(adapter.stop(h, "graceful"), "stop");
    });

    test("a send asking for a schema the process was not started with is refused, and opens no run", async () => {
      const s = spec();
      const h = await spawned(s);
      expect(await review(h, outputPath(s))).toMatchObject({
        ok: false,
        error: {
          class: "validation",
          message: expect.stringContaining("SpawnSpec.output"),
        },
      });
      // Nothing is open: a plain send goes through.
      expect((await review(h)).ok).toBe(true);
      await within(adapter.stop(h, "kill"), "kill");
    });

    test("on an executor that keeps the session (a container), the answer goes through it, on stdin", async () => {
      const argv: Argv[] = [];
      const container: Executor = {
        id: "ctr-stand-in",
        kind: "container",
        capabilities: { pty: false },
        envPath: process.env["PATH"] ?? "/usr/bin:/bin",
        prepare: (p) => local.prepare(p),
        exec: (a, opts) => {
          argv.push(a);
          return local.exec(a, opts);
        },
        pty: (a, opts) => local.pty(a, opts),
        probe: (ref) => local.probe(ref),
        cleanup: (ref, mode) => local.cleanup(ref, mode),
        capacity: () => local.capacity(),
        health: (limits) => local.health(limits),
      };
      const s = spec({}, { output: OUTPUT });
      const h = await spawned(s, container);
      const path = outputPath(s);
      expect((await review(h, path)).ok).toBe(true);
      await runEvents(h);
      const writes = argv.filter((a) => a[0] === "/bin/sh" && a.includes(path));
      expect(writes).toHaveLength(1);
      expect(JSON.stringify(writes)).not.toContain("add returns a - b");
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        summary: expect.any(String),
      });
      await within(adapter.stop(h, "graceful"), "stop");
    });
  },
);

describe("the pure parts", () => {
  test("outputFormatFor strips only the $schema declaration; none without a schema", () => {
    expect(outputFormatFor(undefined)).toEqual({});
    expect(
      outputFormatFor({ schema: { $schema: "x", type: "object", $id: "k" } }),
    ).toEqual({
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", $id: "k" },
      },
    });
  });

  test("outputTarget: none asked, the spawn's schema in any key order, another schema, none at spawn", () => {
    const at = "/s/output/run-1.json";
    const schema = { type: "object", required: ["a"] };
    expect(outputTarget({ schema }, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      outputTarget(
        { schema },
        { schema: { required: ["a"], type: "object" }, path: at },
      ),
    ).toEqual({ ok: true, value: at });
    expect(
      outputTarget({ schema }, { schema: { type: "array" }, path: at }),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(outputTarget(undefined, { schema, path: at })).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  test("OutputSlot hands its path to one result only", () => {
    const slot = new OutputSlot();
    slot.arm("/p");
    expect(slot.take()).toBe("/p");
    expect(slot.take()).toBeUndefined();
  });

  test("resultFrameOf reads result lines only, whole and parseable", () => {
    const rec = (text: string, partial = false): RawRecord => ({
      bytes: new TextEncoder().encode(text),
      partial,
    });
    const line = JSON.stringify({
      type: "result",
      structured_output: { a: 1 },
    });
    expect(resultFrameOf(rec(line))?.structured_output).toEqual({ a: 1 });
    expect(resultFrameOf(rec(line, true))).toBeUndefined();
    expect(
      resultFrameOf(rec('{"type":"assistant","result":1}')),
    ).toBeUndefined();
    expect(resultFrameOf(rec('"result" but not JSON {'))).toBeUndefined();
  });
});
