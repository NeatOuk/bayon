// A private https origin: the mirror's first clone and the spawn's base fetch are
// offered the forge token under delivery's rule, against a stand-in forge that demands a credential
// the way GitHub does. Without the secret, the spawn fails as it did in the field — without asking
// anybody anything — and with it, the token reaches git only through its environment: never an
// argv element, a log line, an error message or the mirror's config.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, forgeTokenSecret } from "@bayon/core";
import {
  getHumanRequest,
  getSession,
  getTicket,
  listHandoffs,
  listSessionsInStates,
  listSessionWorktrees,
} from "@bayon/db";
import { seedRows, tempDb, ticketRow, unwrap } from "@bayon/db/testing";
import {
  GIT_TOKEN_ENV,
  GIT_TOKEN_HOST_ENV,
  LocalExecutor,
  SlotCounter,
  type Executor,
} from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { afterAll, describe, expect, test } from "vitest";
import { originGitAuth } from "../forge/credential.js";
import type { Log } from "./context.js";
import { runArgv } from "./exec.js";
import { envSecrets } from "./secrets.js";
import { ensureMirror } from "./mirror.js";
import { DEFAULT_SETTINGS } from "./settings.js";
import { FORGE_URL, standInForge } from "./testing/forge-remote.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import { executorMirrorGit } from "./workspace.js";
import { fetchBase, withGitAuth } from "./workspace-plan.js";

const T0 = 1_700_000_000_000;
const TOKEN = "ghp_standin_tok_5f1d0c9e";
const SECRET = { [`FRM_SECRET_${forgeTokenSecret("github")}`]: TOKEN };
const GIT_TIMEOUT_MS = 30_000;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A home with a source repository (one commit on main) and the stand-in forge serving it. */
function world() {
  const home = tempHome("frm-origin-auth-");
  cleanups.push(() => home.cleanup());
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const forge = standInForge({ dir: home.path, source: src, token: TOKEN });
  return { home: home.path, src, forge, mirror: join(home.path, "mirror.git") };
}

/** Nothing the test can see carries the token: argv, the mirror's config. */
function expectNoTokenIn(w: ReturnType<typeof world>): void {
  for (const call of w.forge.calls()) {
    for (const arg of call.args) expect(arg).not.toContain(TOKEN);
  }
  try {
    expect(readFileSync(join(w.mirror, "config"), "utf8")).not.toContain(TOKEN);
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
}

const clonesAndFetches = (w: ReturnType<typeof world>) =>
  w.forge
    .calls()
    .filter((c) => c.args.includes("clone") || c.args.includes("fetch"));

describe("the mirror's reads from a private https origin", () => {
  const logged: object[] = [];
  const log: Log = {
    info: (obj) => logged.push(obj),
    warn: (obj) => logged.push(obj),
    error: (obj) => logged.push(obj),
  };
  const ctxOf = (path: string) => ({
    settings: {
      ...DEFAULT_SETTINGS,
      "workspace.git_timeout_ms": GIT_TIMEOUT_MS,
    },
    clock: new FakeClock(T0),
    frmHome: "/",
    path,
    log,
  });
  const repoOf = (mirror: string, origin = FORGE_URL) => ({
    id: "repo_1",
    origin_url: origin,
    mirror_path: mirror,
    default_base_branch: "main",
  });

  test("the first clone is offered the token and succeeds; without it, it fails without prompting", async () => {
    const w = world();
    const ctx = ctxOf(w.forge.path);
    const refused = await ensureMirror(
      ctx,
      repoOf(w.mirror),
      new AbortController().signal,
      await originGitAuth(envSecrets({}), FORGE_URL),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toContain("could not read Username");
    }
    const auth = await originGitAuth(envSecrets(SECRET), FORGE_URL);
    const cloned = await ensureMirror(
      ctx,
      repoOf(w.mirror),
      new AbortController().signal,
      auth,
    );
    expect(cloned).toEqual({ ok: true, value: "cloned" });
    expect(git(w.mirror, "rev-parse", "refs/heads/main")).toBe(
      git(w.src, "rev-parse", "HEAD"),
    );
    const clones = w.forge.calls().filter((c) => c.args.includes("clone"));
    expect(clones.map((c) => c.tokenInEnv)).toEqual([false, true]);
    // The mirror records the plain origin, and no helper: the credential was for that one run.
    expect(git(w.mirror, "config", "--get", "remote.origin.url")).toBe(
      FORGE_URL,
    );
    expect(readFileSync(join(w.mirror, "config"), "utf8")).not.toContain(
      "x-access-token",
    );
    expectNoTokenIn(w);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });

  test("a first clone from a host the policy refuses never runs git, and says why (review M1, M2)", async () => {
    const w = world();
    const ctx = ctxOf(w.forge.path);
    for (const origin of [
      "https://10.0.0.5/acme/private.git",
      "https://169.254.169.254/x.git",
      "http://github.com/acme/private.git",
    ]) {
      const refused = await ensureMirror(
        ctx,
        repoOf(w.mirror, origin),
        new AbortController().signal,
      );
      expect(refused).toMatchObject({
        ok: false,
        error: {
          class: "repo_unreachable",
          retryable: false,
          cause: { outcome: "refused" },
        },
      });
    }
    expect(w.forge.calls()).toEqual([]);
  });

  test("the base fetch through the executor is offered the token; without it, it fails and names no token", async () => {
    const w = world();
    const ctx = ctxOf(w.forge.path);
    const auth = await originGitAuth(envSecrets(SECRET), FORGE_URL);
    unwrap(
      await ensureMirror(
        ctx,
        repoOf(w.mirror),
        new AbortController().signal,
        auth,
      ),
    );
    git(w.src, "commit", "-q", "--allow-empty", "-m", "two");
    const executor = new LocalExecutor({
      id: EXECUTOR_ID,
      slots: new SlotCounter(1),
    });
    const plain = executorMirrorGit(ctx, executor);
    const bare = await fetchBase(
      plain,
      repoOf(w.mirror),
      new AbortController().signal,
    );
    expect(bare.ok).toBe(false);
    if (!bare.ok) {
      // Access gone after the mirror was cloned: said as plainly as a failed first clone.
      expect(bare.error.class).toBe("repo_unreachable");
      expect(bare.error.message).toContain("could not read Username");
      expect(bare.error.message).not.toContain(TOKEN);
    }
    const fetched = await fetchBase(
      withGitAuth(plain, auth),
      repoOf(w.mirror),
      new AbortController().signal,
    );
    expect(fetched).toEqual({ ok: true, value: undefined });
    expect(git(w.mirror, "rev-parse", "refs/remotes/origin/main")).toBe(
      git(w.src, "rev-parse", "HEAD"),
    );
    const fetches = w.forge.calls().filter((c) => c.args.includes("fetch"));
    expect(fetches.map((c) => c.tokenInEnv)).toEqual([false, true]);
    expectNoTokenIn(w);
    expect(JSON.stringify(logged)).not.toContain(TOKEN);
  });
});

describe("a spawn whose repo's origin is a private https repository", () => {
  async function setup(o: {
    readonly origin: "forge" | "path";
    readonly secret: boolean;
  }) {
    const w = world();
    const clock = new FakeClock(T0);
    const t = unwrap(await tempDb(clock));
    unwrap(
      await seedRows(t.db, {
        ...lifecycleRows(),
        repos: [
          {
            id: "repo",
            name: "repo",
            origin_url: o.origin === "forge" ? FORGE_URL : w.src,
            mirror_path: w.mirror,
            doctrine_paths_json: "[]",
          },
        ],
        workspaces: [{ id: "ws", name: "ws", kind: "single" }],
        tickets: [ticketRow(1, { status: "staffed", workspace_id: "ws" })],
        workspace_repos: [
          {
            workspace_id: "ws",
            repo_id: "repo",
            rel_path: "repo",
            role: "primary",
          },
        ],
      }),
    );
    const slots = new SlotCounter(4);
    const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
    const started = await startLifecycle({
      db: t.db,
      clock,
      frmHome: w.home,
      executor,
      slots,
      adapter: createFixtureAdapter({ clock }),
      path: w.forge.path,
      ...(o.secret ? { secrets: SECRET } : {}),
    });
    cleanups.push(async () => {
      started.lifecycle.shutdown();
      const live = await listSessionsInStates(t.db, ["idle", "running"]);
      for (const s of live.ok ? live.value : []) {
        if (s.executor_ref !== null)
          await executor.cleanup(s.executor_ref, "hard");
      }
      t.cleanup();
    });
    const spawn = async (id: string, ticketId?: string) => {
      unwrap(
        await started.lifecycle.handlers.spawn.handle(
          spawnPayload(id, {
            workspace_id: "ws",
            ...(ticketId === undefined ? {} : { ticket_id: ticketId }),
          }),
          CMD,
        ),
      );
      await started.lifecycle.settled();
      return unwrap(await getSession(t.db, id));
    };
    return { ...started, w, db: t.db, spawn };
  }

  test("with FORGE_TOKEN_GITHUB in the store: the clone and the fetch authenticate, the token in env only", async () => {
    const h = await setup({ origin: "forge", secret: true });
    const s = await h.spawn("A1");
    expect(s.state).toBe("idle");
    expect(unwrap(await listSessionWorktrees(h.db, "A1"))[0]).toMatchObject({
      base_sha: git(h.w.src, "rev-parse", "HEAD"),
      state: "active",
    });
    const reads = clonesAndFetches(h.w);
    expect(
      reads.map((c) => c.args.find((a) => a === "clone" || a === "fetch")),
    ).toEqual(["clone", "fetch"]);
    expect(reads.every((c) => c.tokenInEnv)).toBe(true);
    expectNoTokenIn(h.w);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  test("without it: the spawn fails at the workspace step as in the field, and nothing names a token", async () => {
    const h = await setup({ origin: "forge", secret: false });
    const s = await h.spawn("B1");
    expect(s).toMatchObject({
      state: "exited",
      exit_reason: "error",
      error_class: "repo_unreachable",
    });
    expect(s.error_message).toContain("could not read Username");
    expect(clonesAndFetches(h.w).some((c) => c.tokenInEnv)).toBe(false);
  });

  test("a clone that fails on a staffed ticket says why in plain words, on the session, the hand-off and the blocked ticket", async () => {
    const h = await setup({ origin: "forge", secret: false });
    const s = await h.spawn("D1", "ticket-1");
    expect(s).toMatchObject({
      state: "exited",
      error_class: "repo_unreachable",
    });
    // The plain reason first, what to do, then git's own words.
    expect(s.error_message).toMatch(
      /^Repo repo: Bayon cannot read https:\/\/github\.com\/acme\/private\.git: the repository does not exist, or it is private and Bayon has no token for github\.com\./,
    );
    expect(s.error_message).toContain("FORGE_TOKEN_GITHUB");
    expect(s.error_message).toContain("git said:");
    // The ticket is blocked with a short reason and a request in Needs you; re-staffing would fail
    // the same way, so nothing is retried until the operator fixes the repo and unblocks.
    const ticket = unwrap(await getTicket(h.db, "ticket-1"));
    expect(ticket.status).toBe("blocked");
    expect(ticket.blocked_reason).toBe(
      "repo repo cannot be read: not found, or no access",
    );
    const requestId = /human request (\S+)\)/.exec(
      ticket.unblock_condition ?? "",
    )?.[1];
    const request = unwrap(await getHumanRequest(h.db, requestId ?? ""));
    expect(request).toMatchObject({
      kind: "repo_access",
      ticket_id: "ticket-1",
      session_id: "D1",
    });
    expect(request.question).toContain("FORGE_TOKEN_GITHUB");
    // The degraded hand-off is what staffs a successor after the unblock; it says why too.
    const handoffs = unwrap(
      await listHandoffs(h.db, { ticketId: "ticket-1", limit: 5 }),
    ).rows;
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.facts_json).toContain("Bayon cannot read");
    for (const text of [
      s.error_message,
      ticket.blocked_reason,
      request.question,
      request.context_md,
      handoffs[0]?.facts_json,
      JSON.stringify(h.logs),
    ]) {
      expect(text ?? "").not.toContain(TOKEN);
    }
  });

  test("a local-path origin is never offered the token, the store holding it or not", async () => {
    const h = await setup({ origin: "path", secret: true });
    const s = await h.spawn("C1");
    expect(s.state).toBe("idle");
    const reads = clonesAndFetches(h.w);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.some((c) => c.tokenInEnv)).toBe(false);
    for (const c of reads) {
      expect(c.args.join(" ")).not.toContain("x-access-token");
    }
  });
});

describe("a git off this host is never handed the token (Invariant 11)", () => {
  /** A container-kind executor that records each program's argv and env. */
  function remoteExecutor() {
    const seen: { argv: readonly string[]; env: Record<string, string> }[] = [];
    const fake = new FakeExecutor({
      programs: {
        git: (io) => {
          seen.push({ argv: io.argv, env: { ...io.env } });
          return 0;
        },
      },
    });
    const executor = {
      id: "box",
      kind: "container",
      capabilities: fake.capabilities,
      exec: (argv, opts) => fake.exec(argv, opts),
    } as Pick<Executor, "id" | "kind" | "capabilities" | "exec"> as Executor;
    return { executor, seen };
  }
  const ctx = {
    settings: {
      ...DEFAULT_SETTINGS,
      "workspace.git_timeout_ms": GIT_TIMEOUT_MS,
    },
    clock: new FakeClock(T0),
    frmHome: "/",
    path: "/usr/bin:/bin",
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  test("withGitAuth over a non-local executor's mirror git adds no flag and no env", async () => {
    const { executor, seen } = remoteExecutor();
    const auth = await originGitAuth(envSecrets(SECRET), FORGE_URL);
    expect(auth.flags.length).toBeGreaterThan(0);
    const g = withGitAuth(executorMirrorGit(ctx, executor), auth);
    const ran = await g(
      "/mirrors/repo.git",
      ["fetch", "origin"],
      new AbortController().signal,
    );
    expect(ran.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.env[GIT_TOKEN_ENV]).toBeUndefined();
    expect(call?.env[GIT_TOKEN_HOST_ENV]).toBeUndefined();
    expect(call?.argv.join(" ")).not.toContain("x-access-token");
    expect(JSON.stringify(call)).not.toContain(TOKEN);
  });

  test("runArgv drops a caller's env on a non-local executor", async () => {
    const { executor, seen } = remoteExecutor();
    await runArgv(ctx, executor, ["git", "fetch"], {
      what: "git fetch",
      env: { [GIT_TOKEN_ENV]: TOKEN },
    });
    expect(seen[0]?.env[GIT_TOKEN_ENV]).toBeUndefined();
  });
});
