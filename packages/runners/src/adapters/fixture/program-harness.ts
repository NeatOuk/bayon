// The fixture program run in-process on a controllable stdin: its own tests' harness. Never
// imported by the runner itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SCRIPT,
  FixtureScript,
  runFixture,
  type FixtureFetch,
  type FixtureScriptInput,
} from "./program.js";

let dirs: readonly string[] = [];

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "frm-fixture-"));
  dirs = [...dirs, dir];
  return dir;
}

/** For `afterEach`: removes every directory `tempDir` made. */
export function removeTempDirs(): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
}

/** A fetch for tests that make no MCP call: any call is a bug. */
export const noFetch: FixtureFetch = () =>
  Promise.reject(new Error("this test makes no network call"));

export type ProgramHarness = {
  readonly exit: Promise<number>;
  readonly home: string;
  readonly cwd: string;
  readonly stderr: () => string;
  /** Resolves with the next stdout line, parsed. */
  next(): Promise<Record<string, unknown>>;
  /** Everything written so far, parsed. */
  lines(): Record<string, unknown>[];
  op(value: Record<string, unknown>): void;
  eof(): void;
  readonly crashes: () => number;
  readonly termIgnored: () => boolean;
};

export interface StartOptions {
  readonly script?: FixtureScriptInput;
  readonly resume?: boolean;
  readonly runnerSessionId?: string;
  readonly home?: string;
  readonly cwd?: string;
  /** The session's MCP server, as the adapter puts it in the spec (the token rides in env). */
  readonly mcp?: { readonly url: string; readonly tools: readonly string[] };
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FixtureFetch;
  /** SpawnSpec.extraRoots, as the adapter puts them in the spec. */
  readonly extraRoots?: readonly string[];
}

/** Runs the program in-process on a controllable stdin. */
export function start(options: StartOptions): ProgramHarness {
  const home = options.home ?? tempDir();
  const cwd = options.cwd ?? tempDir();
  const encoder = new TextEncoder();
  const input: Uint8Array[] = [];
  let ended = false;
  let wakeInput: (() => void) | undefined;
  async function* stdin() {
    for (;;) {
      const chunk = input.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (ended) return;
      await new Promise<void>((r) => (wakeInput = r));
    }
  }
  const feed = () => {
    const wake = wakeInput;
    wakeInput = undefined;
    wake?.();
  };
  let out = "";
  let err = "";
  const waiters: (() => void)[] = [];
  let taken = 0;
  let crashes = 0;
  let termIgnored = false;
  const lines = () =>
    out
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const script = options.script ?? DEFAULT_SCRIPT;
  const exit = runFixture({
    argv: [
      "fixture",
      "--spec",
      JSON.stringify({
        runnerSessionId: options.runnerSessionId ?? "rs-1",
        homeDir: home,
        resume: options.resume ?? false,
        script: FixtureScript.parse(script),
        ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
        ...(options.extraRoots === undefined
          ? {}
          : { extraRoots: options.extraRoots }),
      }),
    ],
    cwd,
    env: options.env ?? {},
    fetch: options.fetch ?? noFetch,
    stdin: stdin(),
    stdout: {
      write: (chunk) => {
        out += chunk;
        for (const wake of waiters.splice(0)) wake();
      },
    },
    stderr: { write: (chunk) => void (err += chunk) },
    crash: async () => {
      crashes += 1;
      return 137;
    },
    ignoreTerm: () => {
      termIgnored = true;
    },
  });
  return {
    exit,
    home,
    cwd,
    stderr: () => err,
    lines,
    async next() {
      while (lines().length <= taken) {
        const settled = await Promise.race([
          new Promise<"line">((r) => waiters.push(() => r("line"))),
          exit.then(() => "exit" as const),
        ]);
        if (settled === "exit" && lines().length <= taken) {
          throw new Error("the program exited before writing another line");
        }
      }
      taken += 1;
      const line = lines()[taken - 1];
      if (line === undefined) throw new Error("unreachable");
      return line;
    },
    op(value) {
      input.push(encoder.encode(`${JSON.stringify(value)}\n`));
      feed();
    },
    eof() {
      ended = true;
      feed();
    },
    crashes: () => crashes,
    termIgnored: () => termIgnored,
  };
}

/** The lines up to and including the next terminal. */
export async function untilTerminal(
  h: ProgramHarness,
): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  for (;;) {
    const line = await h.next();
    lines.push(line);
    if (line["kind"] === "terminal") return lines;
  }
}
