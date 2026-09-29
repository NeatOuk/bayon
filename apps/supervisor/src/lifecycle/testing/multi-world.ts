// What the multi-repo and submodule tests share: source repos with origins
// and no mirrors (so every mirror is cloned on first use), the workspace rows for each layout, and a
// certified lifecycle over the local executor and the fixture runner. Test-only. The database comes
// from the test file (only tests import @bayon/db/testing): see startMultiWorld.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listSessionsInStates,
  type Db,
  type SessionRow,
} from "@bayon/db";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import {
  createFixtureAdapter,
  type FixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { expect, vi } from "vitest";
import type { SessionSpawnPayload } from "../payloads.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
  type Started,
} from "./fixtures.js";

export const T0 = 1_700_000_000_000;
export const TICKET = "ticket-1";
export const WAIT = { timeout: 20_000, interval: 10 };
export const TURN = {
  kind: "turn_start",
  runner_type: "fixture.step",
  payload: {},
};

/** git as a test drives it: an identity, and local submodule URLs allowed. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

/** A source repo holding one commit: README.md says its name. */
export function makeSource(home: string, name: string): string {
  const src = join(home, "src", name);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), `${name}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", name);
  return src;
}

export const mirrorOf = (home: string, id: string): string =>
  join(home, "mirrors", `${id}.git`);

export const repoRow = (
  home: string,
  id: string,
  src: string,
  hasSubmodules = 0,
) => ({
  id,
  name: id,
  origin_url: src,
  mirror_path: mirrorOf(home, id),
  doctrine_paths_json: "[]",
  has_submodules: hasSubmodules,
});

/** Ticket 1, building, in the workspace. */
const ticketIn = (workspaceId: string) => [
  {
    id: TICKET,
    num: 1,
    title: "ticket 1",
    type: "chore" as const,
    status: "building",
    origin: "operator",
    workspace_id: workspaceId,
    created_at: 0,
    updated_at: 0,
  },
];

/** A multi workspace `ws`: app (primary) and lib, sibling worktrees. */
export function multiRows(home: string) {
  const app = makeSource(home, "app");
  const lib = makeSource(home, "lib");
  return {
    sources: { app, lib },
    rows: {
      repos: [repoRow(home, "app", app), repoRow(home, "lib", lib)],
      workspaces: [{ id: "ws", name: "ws", kind: "multi" as const }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "app",
          rel_path: "app",
          role: "primary",
        },
        { workspace_id: "ws", repo_id: "lib", rel_path: "lib", role: "dep" },
      ],
      tickets: ticketIn("ws"),
    },
  };
}

/**
 * A submodule workspace `ws`: super → libs/mid → vendor/leaf, each submodule added from its source
 * (a URL foreman never fetches from). `declareLeaf: false` leaves the nested one undeclared.
 */
export function submoduleRows(
  home: string,
  o: {
    readonly declareLeaf?: boolean;
    readonly gitmodules?: (sup: string) => void;
  } = {},
) {
  const leaf = makeSource(home, "leaf");
  const mid = makeSource(home, "mid");
  git(mid, "submodule", "add", "-q", leaf, "vendor/leaf");
  git(mid, "commit", "-q", "-m", "leaf");
  const sup = makeSource(home, "super");
  git(sup, "submodule", "add", "-q", mid, "libs/mid");
  git(sup, "commit", "-q", "-m", "mid");
  if (o.gitmodules !== undefined) {
    o.gitmodules(sup);
    git(sup, "commit", "-q", "-am", "gitmodules");
  }
  const declareLeaf = o.declareLeaf ?? true;
  return {
    sources: { leaf, mid, sup },
    rows: {
      repos: [
        repoRow(home, "super", sup, 1),
        repoRow(home, "mid", mid, 1),
        repoRow(home, "leaf", leaf),
      ],
      workspaces: [{ id: "ws", name: "ws", kind: "submodule" as const }],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "super",
          rel_path: "super",
          role: "primary",
        },
        {
          workspace_id: "ws",
          repo_id: "mid",
          rel_path: "super/libs/mid",
          role: "dep",
          submodule_path: "libs/mid",
        },
        ...(declareLeaf
          ? [
              {
                workspace_id: "ws",
                repo_id: "leaf",
                rel_path: "super/libs/mid/vendor/leaf",
                role: "dep",
                submodule_path: "libs/mid/vendor/leaf",
              },
            ]
          : []),
      ],
      tickets: ticketIn("ws"),
    },
  };
}

/** Rows to seed, by table (the test file's seedRows takes them). */
export type Rows = Readonly<Record<string, readonly object[]>>;

export interface MultiWorld extends Started {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly home: string;
  readonly executor: LocalExecutor;
  readonly slots: SlotCounter;
  /** A builder spawn in `ws` on the ticket; `prompt` opens run 1. */
  spawn(id: string, extra?: Partial<SessionSpawnPayload>): Promise<void>;
  cleanup(): Promise<void>;
}

export interface WorldOptions {
  readonly rows: (home: string) => Rows;
  readonly script?: (home: string) => FixtureScriptInput;
  /** PATH for git and the runner: a fake git goes first. */
  readonly path?: string;
  /** Only for a test that really spawns in parallel for the one agent. */
  readonly maxConcurrency?: number;
  readonly adapter?: (base: FixtureAdapter) => RunnerAdapter;
  /** The host secret store's values, as `FRM_SECRET_<NAME>` (a forge token). */
  readonly secrets?: Readonly<Record<string, string>>;
}

/** The world on the test file's database: `seed` inserts rows, `dropDb` removes it. */
export async function startMultiWorld(
  o: WorldOptions & {
    readonly clock: FakeClock;
    readonly db: Db;
    readonly seed: (rows: Rows) => Promise<void>;
    readonly dropDb: () => void;
  },
): Promise<MultiWorld> {
  const { clock, db } = o;
  const home = tempHome("frm-mr-");
  await o.seed({
    ...lifecycleRows({
      ...(o.script === undefined ? {} : { script: o.script(home.path) }),
      ...(o.maxConcurrency === undefined
        ? {}
        : { maxConcurrency: o.maxConcurrency }),
    }),
    ...o.rows(home.path),
  });
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const base = createFixtureAdapter({ clock });
  const started = await startLifecycle({
    db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: o.adapter?.(base) ?? base,
    ...(o.path === undefined ? {} : { path: o.path }),
    ...(o.secrets === undefined ? {} : { secrets: o.secrets }),
  });
  return {
    ...started,
    db,
    clock,
    home: home.path,
    executor,
    slots,
    spawn: async (id, extra = {}) => {
      const spawned = await started.lifecycle.handlers.spawn.handle(
        spawnPayload(id, { workspace_id: "ws", ticket_id: TICKET, ...extra }),
        CMD,
      );
      if (!spawned.ok) throw new Error(spawned.error.message);
    },
    cleanup: async () => {
      await started.lifecycle.shutdown();
      const live = await listSessionsInStates(db, [
        "idle",
        "running",
        "preparing",
        "spawning",
        "stopping",
      ]);
      for (const s of live.ok ? live.value : []) {
        if (s.executor_ref !== null)
          await executor.cleanup(s.executor_ref, "hard");
      }
      o.dropDb();
      home.cleanup();
    },
  };
}

export async function session(db: Db, id: string): Promise<SessionRow> {
  const found = await getSession(db, id);
  if (!found.ok) throw new Error(found.error.message);
  return found.value;
}

/** Waits, settling the lifecycle each time, until `check` holds. */
export const settle = (
  w: MultiWorld,
  check: () => Promise<void>,
): Promise<void> =>
  vi.waitFor(async () => {
    await w.lifecycle.settled();
    await check();
  }, WAIT);

export const waitState = (w: MultiWorld, id: string, state: string) =>
  settle(w, async () => expect((await session(w.db, id)).state).toBe(state));

/** The kinds of the session's stored events. */
export async function kindsOf(db: Db, id: string): Promise<string[]> {
  const rows = await getEventsSince(db, {
    sessionId: id,
    since: 0,
    limit: 500,
  });
  if (!rows.ok) throw new Error(rows.error.message);
  return rows.value.rows.map((e) => e.kind);
}
