// The one file outside an adapter's own directory that names adapters (Invariant 1). The
// supervisor loads adapters by runner id and registers their rows at boot (amendment 4).
import { err, ok, type Result } from "@bayon/core";
import type { Registration, RunnerAdapter } from "../adapter.js";
import type { ConformanceKit } from "../conformance/types.js";
import { frmError } from "../errors.js";
import { CLAUDE_SDK_KIT } from "./claude-sdk/conformance.js";
import { createClaudeSdkAdapter } from "./claude-sdk/index.js";
import { STUB_CLI } from "./claude-sdk/testing/stub.js";
import { CODEX_EXEC_KIT } from "./codex-exec/conformance.js";
import { createCodexExecAdapter } from "./codex-exec/index.js";
import { DEFAULTS as CODEX_DEFAULTS } from "./codex-exec/registration.js";
import { CODEX_TOOL_OUTPUT } from "./codex-exec/testing/samples.js";
import { STUB_CODEX } from "./codex-exec/testing/stub.js";
import { FIXTURE_KIT } from "./fixture/conformance.js";
import { createFixtureAdapter } from "./fixture/index.js";
import { OPENCODE_KIT } from "./opencode/conformance.js";
import { createOpencodeAdapter } from "./opencode/index.js";
import { DEFAULTS as OPENCODE_DEFAULTS } from "./opencode/registration.js";
import { OPENCODE_TOOL_OUTPUT } from "./opencode/testing/samples.js";
import { STUB_OPENCODE } from "./opencode/testing/stub.js";

const FACTORIES: ReadonlyMap<string, () => RunnerAdapter> = new Map([
  ["claude-sdk", () => createClaudeSdkAdapter()],
  ["codex-exec", () => createCodexExecAdapter()],
  ["fixture", () => createFixtureAdapter()],
  ["opencode", () => createOpencodeAdapter()],
]);

/** A shell result over the §8.5 cap, as a runner's stdout carries it. Tests only. */
export type ToolOutputSample = {
  readonly runnerId: string;
  /** The records, in order; the last one completes the command. */
  readonly records: readonly Uint8Array[];
  /** The command's whole output, which the mapped tool_result must carry. */
  readonly output: string;
};

/** One over-cap shell result per runner that provides one, for ingest's cap test (Invariant 9). */
export const TOOL_OUTPUT_SAMPLES: readonly ToolOutputSample[] = [
  { runnerId: "codex-exec", ...CODEX_TOOL_OUTPUT },
  { runnerId: "opencode", ...OPENCODE_TOOL_OUTPUT },
];

/** Every runner id the supervisor can load. */
export const RUNNER_IDS: readonly string[] = [...FACTORIES.keys()];

/** A fresh adapter for `runnerId`, or `not_found`. */
export function loadAdapter(runnerId: string): Result<RunnerAdapter> {
  const create = FACTORIES.get(runnerId);
  return create === undefined
    ? err(
        frmError("not_found", `no runner adapter ${JSON.stringify(runnerId)}`),
      )
    : ok(create());
}

/** Adapters whose CLI has a stand-in: the real SDK and executor, no key, no spend. Tests only. */
const STUBS: ReadonlyMap<string, () => RunnerAdapter> = new Map([
  [
    "claude-sdk",
    () =>
      createClaudeSdkAdapter({
        pathToExecutable: STUB_CLI,
        executable: "node",
      }),
  ],
  [
    "codex-exec",
    () => createCodexExecAdapter({ bin: [process.execPath, STUB_CODEX] }),
  ],
  [
    "opencode",
    () =>
      createOpencodeAdapter({
        bin: [process.execPath, STUB_OPENCODE],
        // The stand-in runs in Seatbelt where there is one; elsewhere (a Linux CI host) bare.
        ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
      }),
  ],
]);

/** Runner ids `loadStubAdapter` can build. */
export const STUB_RUNNER_IDS: readonly string[] = [...STUBS.keys()];

/** A stand-in for a CLI an adapter runs by name from PATH: that name, and the argv standing in. */
export interface StubCli {
  readonly program: string;
  readonly argv: readonly [string, ...string[]];
}

/**
 * The stand-in CLIs of adapters that find their CLI on PATH, by runner id. A smoke puts a shim
 * named `program` first on the supervisor's PATH, so the daemon's own adapter drives the stand-in
 * with no key and no network. Tests and smokes only.
 */
const STUB_CLIS: ReadonlyMap<string, StubCli> = new Map([
  [
    "codex-exec",
    { program: CODEX_DEFAULTS.bin[0], argv: [process.execPath, STUB_CODEX] },
  ],
  [
    "opencode",
    {
      program: OPENCODE_DEFAULTS.bin[0],
      argv: [process.execPath, STUB_OPENCODE],
    },
  ],
]);

/** `runnerId`'s stand-in CLI, or `not_found`. */
export function stubCli(runnerId: string): Result<StubCli> {
  const cli = STUB_CLIS.get(runnerId);
  return cli === undefined
    ? err(
        frmError(
          "not_found",
          `no stand-in CLI for ${JSON.stringify(runnerId)}`,
        ),
      )
    : ok(cli);
}

/** `runnerId`'s adapter driving its stand-in CLI, or `not_found`. For tests. */
export function loadStubAdapter(runnerId: string): Result<RunnerAdapter> {
  const create = STUBS.get(runnerId);
  return create === undefined
    ? err(frmError("not_found", `no stand-in for ${JSON.stringify(runnerId)}`))
    : ok(create());
}

/** Each runner's conformance kit: its specifics, kept in its own directory. */
const KITS: ReadonlyMap<string, ConformanceKit> = new Map([
  ["claude-sdk", CLAUDE_SDK_KIT],
  ["codex-exec", CODEX_EXEC_KIT],
  ["fixture", FIXTURE_KIT],
  ["opencode", OPENCODE_KIT],
]);

/** `runnerId`'s conformance kit, or `not_found`. */
export function conformanceKit(runnerId: string): Result<ConformanceKit> {
  const kit = KITS.get(runnerId);
  return kit === undefined
    ? err(
        frmError("not_found", `no conformance kit ${JSON.stringify(runnerId)}`),
      )
    : ok(kit);
}

/** Every adapter's rows, for `upsertRegistration` at supervisor boot. */
export function registrations(): readonly Registration[] {
  return [...FACTORIES.values()].map((create) => create().registration());
}
