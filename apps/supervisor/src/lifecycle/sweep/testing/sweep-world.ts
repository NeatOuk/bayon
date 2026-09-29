// A world for the worktree sweep's tests: real git in a temp dir, a real temp
// database seeded through the real writers, a FakeClock, and a `git` first on the sweep's PATH that
// logs every argv and GIT_NO_LAZY_FETCH before it runs the real one (the tests' own git is not
// logged). Only tests import this file, and each hands it its own database (`OpenDb`): the test
// helpers' entry is imported by test files alone (no-sql.test.ts).
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeClock, type Result } from "@bayon/core";
import {
  getSweepWorktree,
  listNeedsAttention,
  type Db,
  type SweepWorktree,
} from "@bayon/db";
import {
  createSession,
  insertWorktree,
  updateSessionState,
  type NewSession,
} from "@bayon/db/supervisor";
import type { Log } from "../../context.js";
import { envSecrets } from "../../secrets.js";
import { KeyedQueue } from "../../session-queue.js";
import { DEFAULT_SETTINGS } from "../../settings.js";
import type { SweepDeps, SweepHooks } from "../deps.js";
import { sweepPass, type SweepSummary } from "../sweep.js";

export const T0 = 1_700_000_000_000;
export const HOUR = 3_600_000;
const PATH = process.env["PATH"] ?? "/usr/bin:/bin";
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

const RUNNER = "fixture";
const AGENT = "agent-fixture";
const RUN_CLASS = "fixture_only";

/** Rows by table, as the caller's seedRows takes them. */
export type Rows = Readonly<Record<string, readonly object[]>>;

/** A test's own temp database, seeded through its own seedRows. */
export interface WorldDb {
  readonly db: Db;
  readonly seed: (rows: Rows) => Promise<void>;
  readonly drop: () => void;
}

export type OpenDb = (clock: FakeClock) => Promise<WorldDb>;

function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.class}: ${r.error.message}`);
  return r.value;
}

/** The tests' own git: a fixed identity, local file transport allowed, never logged. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    REAL_GIT,
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export interface Repo {
  readonly id: string;
  readonly origin: string;
  readonly mirror: string;
  readonly base: string;
  readonly workspace: string;
}

export interface Logged {
  readonly level: "info" | "warn" | "error";
  readonly obj: object;
  readonly msg: string;
}

export interface GitCall {
  readonly env: string;
  readonly args: readonly string[];
}

type Hooks = { -readonly [K in keyof SweepHooks]: SweepHooks[K] };

export interface WorktreeOptions {
  readonly sid: string;
  readonly repo: Repo;
  /** Default ticket-1 (done). */
  readonly ticket?: string | null;
  /** A gate reviewer's session. */
  readonly gate?: string;
  readonly detached?: boolean;
  /** Default two hours before T0. */
  readonly endedAt?: number;
  /** The holder's state; `none`: a row with no session. Default exited. */
  readonly holder?: "exited" | "resumable" | "handed_off" | "none";
  readonly executor?: string;
  readonly state?: "active" | "orphan" | "idle" | "dirty";
  readonly submoduleShas?: string;
  /** Before `worktree add`: `-c worktree.useRelativePaths=true`. */
  readonly addArgs?: readonly string[];
  /** False: the row only, no `git worktree add`. */
  readonly add?: boolean;
  readonly workspace?: string;
}

export interface SweepWorld {
  readonly root: string;
  /** $FRM_HOME as the sweep sees it (a symlink with `symlinkHome`). */
  readonly home: string;
  readonly db: Db;
  readonly clock: FakeClock;
  readonly logs: Logged[];
  readonly live: Set<string>;
  readonly hooks: Hooks;
  readonly deps: SweepDeps;
  repo(id: string, files?: Readonly<Record<string, string>>): Promise<Repo>;
  /** A repo row and its mirror, no workspace (a submodule's child). */
  bareRepo(id: string, origin: string): Promise<Repo>;
  worktree(
    o: WorktreeOptions,
  ): Promise<{ readonly path: string; readonly rowId: string }>;
  gate(id: string, ticket: string): Promise<void>;
  seed(rows: Rows): Promise<void>;
  setting(key: string, valueJson: string): Promise<void>;
  pass(): Promise<SweepSummary>;
  row(id: string): Promise<SweepWorktree>;
  /** v_needs_attention's worktree arms: `<why> <ref>`. */
  attention(): Promise<string[]>;
  calls(): GitCall[];
  clearCalls(): void;
}

const worlds: { root: string; drop: () => void }[] = [];

/** afterAll: every world's files and database. */
export function cleanupWorlds(): void {
  for (const w of worlds.splice(0)) {
    w.drop();
    rmSync(w.root, { recursive: true, force: true });
  }
}

const ticket = (num: number, status: string): object => ({
  id: `ticket-${String(num)}`,
  num,
  title: `ticket ${String(num)}`,
  type: "chore",
  status,
  origin: "operator",
  created_at: 0,
  updated_at: 0,
});

/** The spine seedSpine makes, the container executor, and tickets in four statuses. */
const WORLD_ROWS: Rows = {
  runners: [
    { id: RUNNER, kind: "script", adapter: "fixture", caps_json: "{}" },
  ],
  executors: [
    { id: "local", kind: "local", config_json: "{}" },
    { id: "ctr", kind: "container", config_json: "{}" },
  ],
  agents: [
    {
      id: AGENT,
      name: "fixture",
      kind: "builder",
      runner_id: RUNNER,
      executor_id: "local",
      created_at: T0,
    },
  ],
  run_classes: [
    {
      name: RUN_CLASS,
      context_tokens_cap: 1_000,
      max_turns: 5,
      max_tool_calls: 10,
      wall_clock_ms: 60_000,
      cost_cap_usd: 0.1,
      handoff_at_turns: 0,
      default_tier: "cheap",
    },
  ],
  tickets: [
    ticket(1, "done"),
    ticket(2, "building"),
    ticket(3, "split"),
    ticket(4, "parked"),
  ],
};

const sessionInput = (
  id: string,
  executor: string,
  gate: string | undefined,
): NewSession => ({
  id,
  agent_id: AGENT,
  role: "builder",
  run_class: RUN_CLASS,
  runner_id: RUNNER,
  executor_id: executor,
  session_root: "/tmp/frm-sweep-session",
  home_dir: "/tmp/frm-sweep-home",
  config_hash: "0".repeat(64),
  raw_log_path: "/tmp/frm-sweep-raw.jsonl",
  mcp_token_hash: randomBytes(32).toString("hex"),
  ...(gate === undefined ? {} : { gate_id: gate }),
});

/** A `git` first on PATH that logs each call to `argvLog`, then runs the real one. */
function loggingGit(bin: string, argvLog: string): void {
  mkdirSync(bin);
  writeFileSync(argvLog, "");
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `{ printf 'ENV %s\\n' "\${GIT_NO_LAZY_FETCH:-}"; for a in "$@"; do printf 'ARG %s\\n' "$a"; done; printf 'END\\n'; } >> '${argvLog}'`,
      `exec '${REAL_GIT}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
}

const parseCalls = (argvLog: string): GitCall[] =>
  readFileSync(argvLog, "utf8")
    .split("END\n")
    .filter((r) => r !== "")
    .map((record) => {
      const lines = record.split("\n").filter((l) => l !== "");
      return {
        env: (lines.find((l) => l.startsWith("ENV ")) ?? "ENV ").slice(4),
        args: lines.filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4)),
      };
    });

export async function sweepWorld(
  open: OpenDb,
  o: { readonly symlinkHome?: boolean } = {},
): Promise<SweepWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sweep-")));
  const realHome = join(root, "home");
  mkdirSync(join(realHome, "work"), { recursive: true });
  const home = o.symlinkHome === true ? join(root, "home-link") : realHome;
  if (o.symlinkHome === true) symlinkSync(realHome, home);
  const bin = join(root, "bin");
  const argvLog = join(root, "git-argv.log");
  loggingGit(bin, argvLog);
  const clock = new FakeClock(T0);
  const opened = await open(clock);
  worlds.push({ root, drop: opened.drop });
  const { db, seed } = opened;
  await seed(WORLD_ROWS);
  const logs: Logged[] = [];
  const log: Log = {
    info: (obj, msg) => logs.push({ level: "info", obj, msg }),
    warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
    error: (obj, msg) => logs.push({ level: "error", obj, msg }),
  };
  const live = new Set<string>();
  const hooks: Hooks = {};
  const deps: SweepDeps = {
    db,
    log,
    clock,
    frmHome: home,
    settings: DEFAULT_SETTINGS,
    path: `${bin}:${PATH}`,
    mirrors: new KeyedQueue(),
    liveIds: () => live,
    secrets: envSecrets({}),
    hooks,
  };

  async function bareRepo(id: string, origin: string): Promise<Repo> {
    const mirror = join(realHome, "mirrors", `${id}.git`);
    git(root, "clone", "-q", "--mirror", origin, mirror);
    await seed({
      repos: [{ id, name: id, mirror_path: mirror, origin_url: origin }],
    });
    return {
      id,
      origin,
      mirror,
      base: git(origin, "rev-parse", "HEAD"),
      workspace: `ws-${id}`,
    };
  }

  async function repo(
    id: string,
    files: Readonly<Record<string, string>> = { "README.md": "hello\n" },
  ): Promise<Repo> {
    const origin = join(root, "origins", id);
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "main");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(origin, path)), { recursive: true });
      writeFileSync(join(origin, path), text);
    }
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "base");
    const r = await bareRepo(id, origin);
    await seed({
      workspaces: [{ id: r.workspace, name: r.workspace, kind: "single" }],
      workspace_repos: [
        {
          workspace_id: r.workspace,
          repo_id: id,
          rel_path: id,
          role: "primary",
        },
      ],
    });
    return r;
  }

  async function worktree(w: WorktreeOptions) {
    const path = join(home, "work", w.sid, w.repo.id);
    if (w.add !== false) {
      mkdirSync(dirname(path), { recursive: true });
      git(
        w.repo.mirror,
        ...(w.addArgs ?? []),
        "worktree",
        "add",
        "-q",
        ...(w.detached === true
          ? ["--detach", path, w.repo.base]
          : ["-b", `frm/${w.sid}`, path, w.repo.base]),
      );
    }
    const holder = w.holder ?? "exited";
    if (holder !== "none") {
      must(
        await createSession(
          db,
          sessionInput(w.sid, w.executor ?? "local", w.gate),
        ),
      );
      must(
        await updateSessionState(db, w.sid, {
          from: ["pending"],
          to: holder,
          patch: { ended_at: w.endedAt ?? T0 - 2 * HOUR },
        }),
      );
    }
    const row = must(
      await insertWorktree(db, {
        session_root: join(home, "work", w.sid),
        workspace_id: w.workspace ?? w.repo.workspace,
        repo_id: w.repo.id,
        path,
        branch: w.detached === true ? "detached" : `frm/${w.sid}`,
        base_sha: w.repo.base,
        ticket_id: w.ticket === undefined ? "ticket-1" : w.ticket,
        session_id: holder === "none" ? null : w.sid,
        state: w.state ?? "active",
        ...(w.submoduleShas === undefined
          ? {}
          : { submodule_shas_json: w.submoduleShas }),
      }),
    );
    return { path, rowId: row.id };
  }

  return {
    root,
    home,
    db,
    clock,
    logs,
    live,
    hooks,
    deps,
    repo,
    bareRepo,
    worktree,
    async gate(id, ticketId) {
      await seed({
        gates: [
          {
            id,
            ticket_id: ticketId,
            kind: "code_review",
            state: "passed",
            subject_kind: "diff",
            subject_ref: "a..b",
          },
        ],
      });
    },
    seed,
    async setting(key, valueJson) {
      await seed({
        settings: [{ key, value_json: valueJson, updated_at: 0 }],
      });
    },
    pass: () => sweepPass(deps, new AbortController().signal),
    async row(id) {
      const found = must(await getSweepWorktree(db, id));
      if (found === null) throw new Error(`no worktree row ${id}`);
      return found;
    },
    async attention() {
      return must(await listNeedsAttention(db))
        .filter((a) => a.why.startsWith("worktree_"))
        .map((a) => `${a.why} ${a.ref}`)
        .toSorted();
    },
    calls: () => parseCalls(argvLog),
    clearCalls: () => writeFileSync(argvLog, ""),
  };
}

/** `<mirror>/worktrees/<name>` of a live worktree. */
export const adminOf = (path: string): string =>
  git(path, "rev-parse", "--path-format=absolute", "--git-dir");
