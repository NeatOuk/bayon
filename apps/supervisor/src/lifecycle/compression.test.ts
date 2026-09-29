// Context compression per session (spec M12): the decision (sessionCompression), the
// spec field and its token, the adopt snapshot, the store made before a runner starts and kept after
// its session ends — then the whole path on real git and
// real processes: a project that compresses needs a certificate earned with compression on, a project
// that does not keeps its normal one, both on one model; an adopt follows the session's pin, not the
// project's switch; the token is in the session's redaction list and nowhere in the database.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONTEXT_RULESET, FakeClock } from "@bayon/core";
import {
  getSession,
  listSessionsInStates,
  type Db,
  type SessionRow,
} from "@bayon/db";
import {
  dumpAllRows,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  adoptRuleset,
  contextCompressionSpec,
  contextStoreDir,
  ensureContextStore,
  pinnedRuleset,
  sessionCompression,
} from "./compression.js";
import { redactionList } from "./home.js";
import type { SessionConfig } from "./profile.js";
import { certifyPair } from "./testing/certify.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const T0 = 1_700_000_000_000;
const WAIT = { timeout: 15_000, interval: 10 };
const HEX64 = /^[0-9a-f]{64}$/;
const ON = "P-ON";
const OFF = "P-OFF";
const MODEL = "fixture.standard";

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe("sessionCompression: the project's switch, the adapter, a local executor, a worktree, not MCP-only", () => {
  const compresses: Pick<RunnerAdapter, "compressesContext"> = {
    compressesContext: (ex) => ex.kind === "local",
  };
  const everywhere: Pick<RunnerAdapter, "compressesContext"> = {
    compressesContext: () => true,
  };
  async function db(): Promise<Db> {
    const t = unwrap(await tempDb(new FakeClock(T0)));
    cleanups.push(t.cleanup);
    unwrap(
      await seedRows(t.db, {
        executors: [
          { id: "local", kind: "local", config_json: "{}" },
          { id: "ctr", kind: "container", config_json: "{}" },
        ],
        workspaces: [
          { id: ON, name: ON, kind: "single", context_compression: 1 },
          { id: OFF, name: OFF, kind: "single" },
        ],
      }),
    );
    return t.db;
  }
  const facts = (d: Db) => ({
    db: d,
    adapter: compresses,
    executorId: "local",
    workspaceId: ON,
    worktree: true,
    role: "builder",
  });

  test("every fact true: compressed", async () => {
    const d = await db();
    expect(unwrap(await sessionCompression(facts(d)))).toBe(true);
    expect(pinnedRuleset(true)).toBe(CONTEXT_RULESET);
    expect(pinnedRuleset(false)).toBeNull();
  });

  test.each([
    ["the project has it off", { workspaceId: OFF }],
    ["the session is of no project", { workspaceId: null }],
    ["the adapter declares nothing", { adapter: {} }],
    ["the adapter declares it, not on this executor", { executorId: "ctr" }],
    [
      "the adapter would, but the executor is not local",
      { executorId: "ctr", adapter: everywhere },
    ],
    ["no worktree: the session works in its root", { worktree: false }],
    ["the orchestrator's pulse is MCP-only", { role: "orchestrator" }],
  ] as const)("%s: uncompressed", async (_why, patch) => {
    const d = await db();
    expect(unwrap(await sessionCompression({ ...facts(d), ...patch }))).toBe(
      false,
    );
  });

  test("an unknown project is an error, never a silent off", async () => {
    const d = await db();
    expect(
      await sessionCompression({ ...facts(d), workspaceId: "nope" }),
    ).toMatchObject({ ok: false, error: { class: "not_found" } });
  });
});

describe("the spec field, the adopt ruleset, the store's end", () => {
  test("a fresh 32-byte hex bearer each time, the store under the session root", () => {
    const a = contextCompressionSpec("/frm/work/S1").contextCompression;
    const b = contextCompressionSpec("/frm/work/S1").contextCompression;
    expect(a).toMatchObject({
      ruleset: CONTEXT_RULESET,
      storeDir: "/frm/work/S1/.foreman/ctx",
    });
    expect(a?.token).toMatch(HEX64);
    expect(b?.token).toMatch(HEX64);
    expect(a?.token).not.toBe(b?.token);
    expect(contextStoreDir("/r")).toBe("/r/.foreman/ctx");
  });

  test("an adopt resumes on the pin; a pin this build lacks, on this build's ruleset", () => {
    expect(adoptRuleset(null)).toEqual({ ruleset: null, changed: false });
    expect(adoptRuleset(CONTEXT_RULESET)).toEqual({
      ruleset: CONTEXT_RULESET,
      changed: false,
    });
    expect(adoptRuleset("ctx0")).toEqual({
      ruleset: CONTEXT_RULESET,
      changed: true,
    });
  });

  test("the bearer is in the session's redaction list, beside its MCP token", () => {
    const token = "ab".repeat(32);
    const config: SessionConfig = {
      input: {},
      flags: {},
      env: {},
      secretNames: [],
      secretAnyOf: [],
      hashInputs: [],
      baselineTokens: 0,
      toolAllowlist: [],
    };
    const spec = {
      sessionId: "S1",
      cwd: "/w",
      homeDir: "/h",
      env: {},
      model: "m",
      flags: {},
      contextCompression: {
        ruleset: CONTEXT_RULESET,
        storeDir: "/r/.foreman/ctx",
        token,
      },
    } satisfies SpawnSpec;
    expect(redactionList(spec, config)).toEqual([token]);
  });

  test("the store is made 0700 before a runner starts; a directory already there is kept", async () => {
    const root = mkdtempSync("/tmp/frm-ctx-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = contextStoreDir(join(root, "S"));
    mkdirSync(join(root, "S"));
    expect(await ensureContextStore(store)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(statSync(store).isDirectory()).toBe(true);
    expect(statSync(store).mode & 0o777).toBe(0o700);
    // At adopt it is there already, with its originals: kept as it is.
    writeFileSync(join(store, "a.txt"), "original");
    expect((await ensureContextStore(store)).ok).toBe(true);
    expect(readdirSync(store)).toEqual(["a.txt"]);
  });

  test.each([
    ["`.foreman` a link", ".foreman", "link"],
    ["`ctx` a link", "ctx", "link"],
    ["`.foreman` a file", ".foreman", "file"],
    ["`ctx` a file", "ctx", "file"],
  ] as const)(
    "%s: the start is refused, and nothing is made where it leads",
    async (_why, which, kind) => {
      const root = mkdtempSync("/tmp/frm-ctx-");
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);
      const session = join(root, "S");
      mkdirSync(session);
      const store = contextStoreDir(session);
      if (which === "ctx") mkdirSync(join(session, ".foreman"));
      const at = which === "ctx" ? store : join(session, ".foreman");
      if (kind === "link") symlinkSync(elsewhere, at);
      else writeFileSync(at, "not a directory");
      expect(await ensureContextStore(store)).toMatchObject({
        ok: false,
        error: {
          class: "spawn_failed",
          message: expect.stringContaining(`${at} is not a plain directory`),
        },
      });
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );
});

// ─── the whole path: two projects on one repo and one model, real git, real processes ───────────

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

interface Seen {
  readonly spawned: SpawnSpec[];
  readonly adopted: SpawnSpec[];
  /** Per compressed spec handed over, whether its store was a directory already. */
  readonly storeReady: boolean[];
}

const storeReady = (spec: SpawnSpec): boolean[] => {
  const dir = spec.contextCompression?.storeDir;
  return dir === undefined
    ? []
    : [existsSync(dir) && statSync(dir).isDirectory()];
};

/** The fixture, declaring compression on a local executor, recording each spec it is handed. */
function compressing(base: RunnerAdapter, seen: Seen): RunnerAdapter {
  return {
    ...base,
    compressesContext: (ex) => ex.kind === "local",
    spawn: (spec, ex) => {
      seen.spawned.push(spec);
      seen.storeReady.push(...storeReady(spec));
      return base.spawn(spec, ex);
    },
    adopt: (spec, ex) => {
      seen.adopted.push(spec);
      seen.storeReady.push(...storeReady(spec));
      return base.adopt(spec, ex);
    },
  };
}

async function world(o: { readonly certificates: readonly boolean[] }) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-ctx-");
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const mirror = join(home.path, "mirror.git");
  git(home.path, "clone", "-q", "--mirror", src, mirror);
  unwrap(
    await seedRows(t.db, {
      ...lifecycleRows({ maxConcurrency: 4 }),
      repos: [
        {
          id: "repo",
          name: "repo",
          origin_url: src,
          mirror_path: mirror,
          doctrine_paths_json: "[]",
        },
      ],
      workspaces: [
        { id: ON, name: ON, kind: "single", context_compression: 1 },
        { id: OFF, name: OFF, kind: "single" },
      ],
      workspace_repos: [ON, OFF].map((workspace_id) => ({
        workspace_id,
        repo_id: "repo",
        rel_path: "repo",
        role: "primary",
      })),
    }),
  );
  const seen: Seen = { spawned: [], adopted: [], storeReady: [] };
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots, clock });
  const adapter = compressing(createFixtureAdapter({ clock }), seen);
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter,
    certified: false,
  });
  for (const compression of o.certificates) {
    await certifyPair(t.db, {
      runnerId: adapter.id,
      runnerVersion: "rig",
      caps: adapter.caps(),
      executorId: EXECUTOR_ID,
      at: T0,
      modelIds: [MODEL],
      compression,
    });
  }
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    const live = await listSessionsInStates(t.db, [
      "pending",
      "preparing",
      "spawning",
      "running",
      "idle",
      "stopping",
    ]);
    for (const s of live.ok ? live.value : []) {
      if (s.executor_ref !== null)
        await executor.cleanup(s.executor_ref, "hard");
    }
    t.cleanup();
    home.cleanup();
  });
  const session = async (id: string): Promise<SessionRow> =>
    unwrap(await getSession(t.db, id));
  return {
    ...started,
    db: t.db,
    home: home.path,
    seen,
    session,
    spawn: (id: string, project: string) =>
      started.lifecycle.handlers.spawn.handle(
        spawnPayload(id, { workspace_id: project }),
        CMD,
      ),
    idle: (id: string) =>
      vi.waitFor(async () => {
        await started.lifecycle.settled();
        expect((await session(id)).state).toBe("idle");
      }, WAIT),
    /** kill -9 the session's process, then wait for the lifecycle to see it die. */
    kill9: async (id: string) => {
      const ref = (await session(id)).executor_ref;
      const deaths = () =>
        started.logs.filter((l) => l.msg.startsWith("the runner exited"))
          .length;
      const before = deaths();
      process.kill(Number(ref?.split(":")[1]), "SIGKILL");
      await vi.waitFor(async () => {
        await started.lifecycle.settled();
        expect(deaths()).toBe(before + 1);
      }, WAIT);
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

const specOf = (specs: readonly SpawnSpec[], id: string): SpawnSpec => {
  const spec = specs.findLast((s) => s.sessionId === id);
  if (spec === undefined) throw new Error(`no spec for ${id}`);
  return spec;
};

/** Every table's text: where a secret must never be. */
const everything = async (w: World): Promise<string> =>
  JSON.stringify(unwrap(await dumpAllRows(w.db)));

describe("on real git and processes", { timeout: 60_000 }, () => {
  test("a project that compresses, with only the normal certificate: refused before any row, the command named", async () => {
    const w = await world({ certificates: [false] });
    expect(await w.spawn("A", ON)).toMatchObject({
      ok: false,
      error: {
        class: "admission_refused",
        cause: { gate: "uncertified" },
        message: expect.stringContaining(
          `is not certified with context compression on executor ${EXECUTOR_ID}`,
        ),
      },
    });
    const refused = await w.spawn("A2", ON);
    expect(!refused.ok && refused.error.message).toContain(
      `frm runner conformance fixture --model ${MODEL} --executor ${EXECUTOR_ID} --compression`,
    );
    expect((await getSession(w.db, "A")).ok).toBe(false);
    // The project that does not compress runs on that same certificate.
    unwrap(await w.spawn("B", OFF));
    await w.idle("B");
  });

  test("two projects on one model, each certified its way: both admitted; only the compressed one gets the proxy, and its token stays out of the database", async () => {
    const w = await world({ certificates: [false, true] });
    unwrap(await w.spawn("A", ON));
    unwrap(await w.spawn("B", OFF));
    await w.idle("A");
    await w.idle("B");
    const a = await w.session("A");
    const b = await w.session("B");
    expect(a).toMatchObject({ context_ruleset: CONTEXT_RULESET });
    expect(b).toMatchObject({ context_ruleset: null });
    expect(b.model).toBe(a.model);
    const spec = specOf(w.seen.spawned, "A");
    expect(spec.contextCompression).toMatchObject({
      ruleset: CONTEXT_RULESET,
      storeDir: join(a.session_root, ".foreman", "ctx"),
    });
    const token = spec.contextCompression?.token ?? "";
    expect(token).toMatch(HEX64);
    // The store lies outside the worktree the session works in.
    expect(spec.cwd.startsWith(join(a.session_root, ".foreman"))).toBe(false);
    expect(specOf(w.seen.spawned, "B").contextCompression).toBeUndefined();
    expect(await everything(w)).not.toContain(token);
    expect(JSON.stringify(w.logs)).not.toContain(token);
  });

  test("an adopt keeps the session's snapshot after the project's switch flips, with a fresh token and the same store", async () => {
    const w = await world({ certificates: [false, true] });
    unwrap(await w.spawn("A", ON));
    unwrap(await w.spawn("B", OFF));
    await w.idle("A");
    await w.idle("B");
    const first = specOf(w.seen.spawned, "A").contextCompression;
    unwrap(
      await updateRowForTest(w.db, "workspaces", ON, {
        context_compression: 0,
      }),
    );
    unwrap(
      await updateRowForTest(w.db, "workspaces", OFF, {
        context_compression: 1,
      }),
    );

    await w.kill9("A");
    await w.kill9("B");
    await w.lifecycle.reconcile();
    await w.idle("A");
    await w.idle("B");
    const resumed = specOf(w.seen.adopted, "A").contextCompression;
    expect(resumed).toMatchObject({
      ruleset: CONTEXT_RULESET,
      storeDir: first?.storeDir,
    });
    expect(resumed?.token).toMatch(HEX64);
    expect(resumed?.token).not.toBe(first?.token);
    expect(specOf(w.seen.adopted, "B").contextCompression).toBeUndefined();
    expect(await w.session("A")).toMatchObject({
      context_ruleset: CONTEXT_RULESET,
    });
    expect(await w.session("B")).toMatchObject({ context_ruleset: null });
    expect(await everything(w)).not.toContain(resumed?.token ?? "?");
    // The store was a directory before the runner was handed it, at spawn and at adopt.
    expect(w.seen.storeReady).toEqual([true, true]);
  });

  test("a pin this build lacks: the adopt resumes on this build's ruleset, warns, and re-pins", async () => {
    const w = await world({ certificates: [true] });
    unwrap(await w.spawn("A", ON));
    await w.idle("A");
    unwrap(
      await updateRowForTest(w.db, "sessions", "A", {
        context_ruleset: "ctx0",
      }),
    );
    await w.kill9("A");
    await w.lifecycle.reconcile();
    await w.idle("A");
    expect(specOf(w.seen.adopted, "A").contextCompression?.ruleset).toBe(
      CONTEXT_RULESET,
    );
    expect(await w.session("A")).toMatchObject({
      context_ruleset: CONTEXT_RULESET,
    });
    expect(
      w.logs.some(
        (l) =>
          l.level === "warn" &&
          l.msg.includes("does not have the session's context ruleset"),
      ),
    ).toBe(true);
  });

  test("ending a session, suspended or for good, leaves its store of originals and nothing outside it moves", async () => {
    const w = await world({ certificates: [true] });
    unwrap(await w.spawn("A", ON));
    await w.idle("A");
    const a = await w.session("A");
    const store =
      specOf(w.seen.spawned, "A").contextCompression?.storeDir ?? "";
    expect(statSync(store).mode & 0o777).toBe(0o700);
    const original = join(store, `${"a".repeat(64)}.txt`);
    writeFileSync(original, "original");
    const root = readdirSync(a.session_root).toSorted();
    const state = (want: string) =>
      vi.waitFor(async () => {
        await w.lifecycle.settled();
        expect((await w.session("A")).state).toBe(want);
      }, WAIT);
    await w.lifecycle.stop("A", "graceful");
    await state("resumable");
    expect(existsSync(original)).toBe(true);
    // Killed while suspended: discarded, over for good; the store stays with the root, as its logs do.
    await w.lifecycle.stop("A", "kill");
    await state("exited");
    expect(readdirSync(store)).toEqual([`${"a".repeat(64)}.txt`]);
    expect(readdirSync(a.session_root).toSorted()).toEqual(root);
  });

  test("a file where the store's `.foreman` goes fails the spawn before its runner starts", async () => {
    const w = await world({ certificates: [true] });
    // The session root the spawn will use, with `.foreman` planted as a file before it starts.
    const root = join(w.home, "work", "A");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".foreman"), "not a directory");
    unwrap(await w.spawn("A", ON));
    await vi.waitFor(async () => {
      await w.lifecycle.settled();
      expect(await w.session("A")).toMatchObject({
        state: "exited",
        error_class: "spawn_failed",
        error_message: expect.stringContaining(
          `${join(root, ".foreman")} is not a plain directory`,
        ),
      });
    }, WAIT);
    expect(w.seen.spawned).toEqual([]);
  });

  test("a link planted where the store goes refuses the adopt, and nothing is made where it leads", async () => {
    const w = await world({ certificates: [true] });
    unwrap(await w.spawn("A", ON));
    await w.idle("A");
    const a = await w.session("A");
    const store =
      specOf(w.seen.spawned, "A").contextCompression?.storeDir ?? "";
    await w.kill9("A");
    // While no process runs: `.foreman` swapped for a link to a directory of the session's choosing.
    const elsewhere = mkdtempSync("/tmp/frm-ctx-elsewhere-");
    cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
    rmSync(join(a.session_root, ".foreman"), { recursive: true });
    symlinkSync(elsewhere, join(a.session_root, ".foreman"));
    await w.lifecycle.reconcile();
    await vi.waitFor(async () => {
      await w.lifecycle.settled();
      expect(await w.session("A")).toMatchObject({
        state: "exited",
        exit_reason: "error",
        error_class: "spawn_failed",
        error_message: expect.stringContaining(
          `${join(a.session_root, ".foreman")} is not a plain directory`,
        ),
      });
    }, WAIT);
    expect(w.seen.adopted.filter((x) => x.sessionId === "A")).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(store).toBe(join(a.session_root, ".foreman", "ctx"));
  });
});
