import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, type Clock, type Result } from "@bayon/core";
import type { Db } from "@bayon/db";
import { DEFAULT_SETTINGS } from "../../lifecycle/settings.js";
import type { DeliveryCtx } from "../context.js";

// A delivery world on disk (tests): real git repositories, and the rows one project
// needs. Three directories per repo — a working source, the bare **mirror** delivery pushes from,
// and a bare **remote** standing in for the project's origin — so every push, ls-remote and fetch in
// these tests is a real one, and nothing ever reaches a network.
//
// The database is the caller's: seeding goes through @bayon/db/testing in each test file, since only
// a test may import it (no-sql.test.ts). `projectRows` hands back the rows, and nothing more.

export const T0 = 1_700_000_000_000;
export const BRANCH = "frm/s1";
export const TICKET = "ticket-1";
export const PROJECT = "ws-1";

/** git as a test drives it: its own identity, and local submodule URLs allowed. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.test",
      "-c",
      "user.name=t",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

export interface Home {
  readonly path: string;
  cleanup(): void;
}

export function tempHome(prefix = "frm-delivery-"): Home {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export interface RepoOnDisk {
  readonly id: string;
  readonly src: string;
  readonly mirror: string;
  readonly remote: string;
  /** The commit `BRANCH` points at in the mirror. */
  readonly head: string;
}

/**
 * One repo: a source with `main` and one more commit on `BRANCH`, a bare mirror cloned from it, and
 * an empty bare remote. The remote is a **path**, so it has no forge kind — a test that wants one
 * hands the job a `forgeRemoteOf` of its own.
 */
export function makeRepo(home: string, id: string): RepoOnDisk {
  const src = join(home, "src", id);
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), `${id}\n`);
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "base");
  git(src, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(src, "change.txt"), "work\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "the work");

  const mirror = join(home, "mirrors", `${id}.git`);
  mkdirSync(join(home, "mirrors"), { recursive: true });
  git(home, "clone", "-q", "--bare", src, mirror);

  const remote = join(home, "remotes", `${id}.git`);
  mkdirSync(join(home, "remotes"), { recursive: true });
  git(home, "init", "-q", "--bare", remote);

  return { id, src, mirror, remote, head: git(mirror, "rev-parse", BRANCH) };
}

/** `refs/heads/<branch>` on a bare repo, or null when it has none. */
export function remoteRef(repo: string, branch = BRANCH): string | null {
  const out = git(
    repo,
    "for-each-ref",
    "--format=%(objectname)",
    `refs/heads/${branch}`,
  );
  return out === "" ? null : out;
}

/** An unrelated commit put on the remote's own `BRANCH`: what must never be clobbered. */
export function strandOnRemote(home: string, repo: RepoOnDisk): string {
  const other = join(home, "other", repo.id);
  mkdirSync(other, { recursive: true });
  git(other, "init", "-q", "-b", BRANCH);
  writeFileSync(join(other, "theirs.txt"), "someone else\n");
  git(other, "add", ".");
  git(other, "commit", "-q", "-m", "not ours");
  git(
    other,
    "push",
    "-q",
    repo.remote,
    `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
  );
  return git(other, "rev-parse", BRANCH);
}

export interface FakeGit {
  /** Put this on `ctx.path`: git resolves to the script in it and nothing else does. */
  readonly dir: string;
  /** Every call it saw, as `ARGS:…` and `TOKEN:…` lines. */
  lines(): string[];
}

/**
 * A `git` on PATH that is ours (scrub and credential tests). Real repositories cannot
 * be made to print a secret on demand, and an auth failure that echoes a remote's userinfo needs a
 * server; this makes both deterministic, and records the argv and the credential environment git
 * was actually given.
 *
 * `rev-parse` answers a fixed sha; everything else exits 0, or, with `failWith`, writes that text
 * to stderr and exits 128. The paths and the message are baked into the script, because
 * `hostGitRun` hands git only PATH, its credential variable and the environment floor.
 */
export function fakeGit(
  home: string,
  o: { readonly failWith?: string; readonly sha?: string } = {},
): FakeGit {
  const dir = join(home, `fake-git-${String(Math.random()).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  const sha = o.sha ?? "a".repeat(40);
  const fail =
    o.failWith === undefined
      ? "exit 0\n"
      : `printf '%s\\n' ${shQuote(o.failWith)} >&2\nexit 128\n`;
  const script =
    "#!/bin/sh\n" +
    `printf 'ARGS:%s\\nTOKEN:%s\\n' "$*" "\${FRM_FORGE_TOKEN-}" >> ${shQuote(log)}\n` +
    `case "$*" in\n  *rev-parse*) printf '%s\\n' ${shQuote(sha)}; exit 0;;\nesac\n` +
    fail;
  writeFileSync(join(dir, "git"), script, { mode: 0o755 });
  return {
    dir,
    lines: () => {
      try {
        return readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== "");
      } catch {
        return [];
      }
    },
  };
}

/** A single-quoted shell word: the only quoting these scripts need. */
const shQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export interface LogLine {
  readonly obj: object;
  readonly msg: string;
}

/** A secret store answering from a plain map: a name it does not hold is a miss, as the host's is. */
export const secretsOf = (
  values: Readonly<Record<string, string>> = {},
): DeliveryCtx["secrets"] => ({
  get: (name: string) =>
    Promise.resolve(
      name in values
        ? (ok(values[name] ?? "") as Result<string>)
        : {
            ok: false as const,
            error: {
              class: "not_found" as const,
              message: `no ${name}`,
              retryable: false,
            },
          },
    ),
});

export interface World {
  readonly db: Db;
  readonly home: Home;
  readonly ctx: DeliveryCtx;
  readonly logs: LogLine[];
  cleanup(): void;
}

/** A temp home and a bare `DeliveryCtx` over the caller's database. Seed its rows yourself. */
export function makeWorld(
  db: Db,
  clock: Clock,
  over: Partial<DeliveryCtx> = {},
): World {
  const home = tempHome();
  const logs: LogLine[] = [];
  const log = {
    info: (obj: object, msg: string) => logs.push({ obj, msg }),
    warn: (obj: object, msg: string) => logs.push({ obj, msg }),
    error: (obj: object, msg: string) => logs.push({ obj, msg }),
  };
  const ctx: DeliveryCtx = {
    db,
    frmHome: home.path,
    clock,
    log,
    settings: DEFAULT_SETTINGS,
    path: process.env.PATH ?? "/usr/bin:/bin",
    secrets: secretsOf(),
    ...over,
  };
  return { db, home, ctx, logs, cleanup: () => home.cleanup() };
}

export interface ProjectRows {
  readonly repos: readonly RepoOnDisk[];
  readonly kind?: "single" | "multi" | "submodule";
  readonly mode?: "none" | "push" | "pull_request";
  readonly when?: "review_passed" | "done";
  readonly status?: string;
  /** Which of `repos` are submodules, by id, and where they sit. */
  readonly submodulePaths?: Readonly<Record<string, string>>;
  /** A repo's `origin_url` in place of its bare remote: null is a project with none recorded. */
  readonly origins?: Readonly<Record<string, string | null>>;
  /**
   * A repo's `push_url` (039), by id; absent: none, so it pushes to its origin. Seeded straight into
   * the row, past the settings writer's shape rule, so a test may point one at a local bare repo.
   */
  readonly pushUrls?: Readonly<Record<string, string>>;
}

/**
 * The ticket_event that says `ticketId` entered `status` at `ts`: what the ticket writers leave, and
 * what the sweep reads as the time it reached its moment. A `created` event — filed
 * straight into the status — so a test's own `transition` events stay the only ones it finds.
 */
export const enteredAt = (ticketId: string, status: string, ts = T0) => ({
  ticket_id: ticketId,
  ts,
  actor_kind: "operator",
  kind: "created",
  to_status: status,
});

/**
 * A delivering project's `delivery_since` (047): turned on at T0, so every ticket that entered its
 * status at T0 or later reached its moment while delivery was on. NULL while it delivers nothing.
 */
export const deliverySince = (mode: string): number | null =>
  mode === "none" ? null : T0;

/**
 * The project, its repos, one ticket at `status` (entered at T0), and a worktree per repo on
 * `BRANCH`. Delivery was turned on at T0, so the ticket reached its moment while it was on.
 */
export function projectRows(p: ProjectRows) {
  const paths = p.submodulePaths ?? {};
  const mode = p.mode ?? "pull_request";
  const status = p.status ?? "qa_human";
  return {
    repos: p.repos.map((r) => ({
      id: r.id,
      name: r.id,
      origin_url:
        (p.origins ?? {})[r.id] ??
        (r.id in (p.origins ?? {}) ? null : r.remote),
      push_url: (p.pushUrls ?? {})[r.id] ?? null,
      mirror_path: r.mirror,
      default_base_branch: "main",
      doctrine_paths_json: "[]",
    })),
    workspaces: [
      {
        id: PROJECT,
        name: PROJECT,
        kind: p.kind ?? "single",
        delivery_mode: mode,
        delivery_when: p.when ?? "review_passed",
        delivery_since: deliverySince(mode),
      },
    ],
    workspace_repos: p.repos.map((r) => ({
      workspace_id: PROJECT,
      repo_id: r.id,
      rel_path: paths[r.id] ?? r.id,
      role: paths[r.id] === undefined ? "primary" : "dep",
      submodule_path: paths[r.id] ?? null,
    })),
    tickets: [
      {
        id: TICKET,
        num: 12,
        title: "a change",
        acceptance_md: "it works",
        type: "chore" as const,
        status,
        origin: "operator",
        workspace_id: PROJECT,
        created_at: T0,
        updated_at: T0,
      },
    ],
    ticket_events: [enteredAt(TICKET, status)],
    worktrees: p.repos.map((r, i) => ({
      id: `wt-${i}`,
      session_root: "/tmp/root",
      workspace_id: PROJECT,
      repo_id: r.id,
      path: `/tmp/root/${r.id}`,
      branch: BRANCH,
      base_sha: "0".repeat(40),
      head_sha: r.head,
      ticket_id: TICKET,
      state: "idle" as const,
      created_at: T0,
    })),
  };
}
