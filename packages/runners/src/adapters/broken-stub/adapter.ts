// A deliberately non-compliant runner, for tests only: the fixture adapter
// with up to six seeded bugs, each failing exactly one conformance test on a named check. It is
// not in the registry's FACTORIES, so the supervisor can never load it.
import { mkdir } from "node:fs/promises";
import { ok } from "@bayon/core";
import type {
  Mapper,
  RawRecord,
  Registration,
  RunnerAdapter,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import {
  createFixtureAdapter,
  type FixtureAdapterOptions,
} from "../fixture/adapter.js";

export const BROKEN_STUB_ID = "broken-stub";

export interface BrokenStubFlags {
  /** A stream ending with a run open gets `terminal` inferred from the exit code (fails 9). */
  readonly terminalOnExit?: boolean;
  /** The mapper drops `runner_native` events (fails 10). */
  readonly dropUnknown?: boolean;
  /** `prepareHome` makes the directory but never claims it (fails 14). */
  readonly ignoreHomeClaim?: boolean;
  /** Runner state goes wherever the env's HOME points, not into the claimed home (fails 15). */
  readonly sharedState?: boolean;
  /** The extra roots the spawn granted are dropped, so no write lands in one (fails 16). */
  readonly ignoreExtraRoots?: boolean;
  /** Every path is treated as a root, so a write outside them all lands (fails 16). */
  readonly rootsEverywhere?: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isTerminal(r: RawRecord): boolean {
  if (r.partial) return false;
  try {
    return (
      (JSON.parse(decoder.decode(r.bytes)) as { kind?: unknown }).kind ===
      "terminal"
    );
  } catch {
    return false;
  }
}

/** Whether a run is open on a process, as the seeded bug tracks it. */
interface OpenRun {
  open: boolean;
}

/** The Codex bug (§5.2): EOF with a run open, so the run "must have finished". */
async function* terminalOnExit(
  records: AsyncIterable<RawRecord>,
  h: SessionHandle,
  run: OpenRun,
): AsyncGenerator<RawRecord> {
  for await (const r of records) {
    if (isTerminal(r)) run.open = false;
    yield r;
  }
  if (!run.open) return;
  run.open = false;
  const exit = await h.exited;
  yield {
    partial: false,
    bytes: encoder.encode(
      JSON.stringify({
        kind: "terminal",
        runner_type: "broken-stub.exit",
        payload: {
          outcome: exit.code === 0 ? "ok" : "failed",
          cumulative: {},
        },
      }),
    ),
  };
}

export function createBrokenStubAdapter(
  flags: BrokenStubFlags,
  options: FixtureAdapterOptions = {},
): RunnerAdapter {
  const inner = createFixtureAdapter(options);
  const runs = new WeakMap<SessionHandle, OpenRun>();
  const runOf = (h: SessionHandle): OpenRun => {
    const found = runs.get(h);
    if (found !== undefined) return found;
    const created: OpenRun = { open: false };
    runs.set(h, created);
    return created;
  };
  const base = inner.registration();
  // Its own models rows: sharing the inner runner's ids would move them to this runner on
  // registration, and a certificate is per model.
  const registration: Registration = {
    ...base,
    runner: { ...base.runner, id: BROKEN_STUB_ID, adapter: BROKEN_STUB_ID },
    models: base.models.map((m) => ({
      ...m,
      id: `${BROKEN_STUB_ID}.${m.tier}`,
    })),
  };
  /** Only a session that was granted roots: no other test's session moves (§15 #16). */
  const reroot = (spec: SpawnSpec): SpawnSpec => {
    const roots = spec.extraRoots ?? [];
    if (roots.length === 0) return spec;
    if (flags.ignoreExtraRoots === true) {
      const { extraRoots, ...rest } = spec;
      void extraRoots;
      return rest;
    }
    // "/" is a root, so every path on the machine is inside one.
    return flags.rootsEverywhere === true
      ? { ...spec, extraRoots: [...roots, "/"] }
      : spec;
  };
  const relocate = (spec: SpawnSpec): SpawnSpec =>
    reroot(
      flags.sharedState === true
        ? { ...spec, homeDir: spec.env["HOME"] ?? spec.homeDir }
        : spec,
    );
  const mapperFor = (o: Parameters<RunnerAdapter["createMapper"]>[0]) => {
    const m = inner.createMapper(o);
    return flags.dropUnknown === true
      ? ({
          map: (input) =>
            m.map(input).filter((e) => e.kind !== "runner_native"),
        } satisfies Mapper)
      : m;
  };

  return {
    id: BROKEN_STUB_ID,
    caps: inner.caps,
    registration: () => registration,
    version: inner.version,
    health: inner.health,
    prepareHome:
      flags.ignoreHomeClaim === true
        ? async (spec) => {
            await mkdir(spec.homeDir, { recursive: true, mode: 0o700 });
            return ok({ files: [] });
          }
        : inner.prepareHome,
    spawn: (spec, ex) => inner.spawn(relocate(spec), ex),
    adopt: (spec, ex) => inner.adopt(relocate(spec), ex),
    async send(h, p) {
      const sent = await inner.send(h, p);
      if (sent.ok) runOf(h).open = true;
      return sent;
    },
    records(h) {
      const records = inner.records(h);
      return flags.terminalOnExit === true
        ? terminalOnExit(records, h, runOf(h))
        : records;
    },
    createMapper: mapperFor,
    interrupt: inner.interrupt,
    stop: inner.stop,
    estimateTokens: inner.estimateTokens,
    interactiveResume: inner.interactiveResume,
  };
}
