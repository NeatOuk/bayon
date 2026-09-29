import { basename } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  dumpAllRows,
  seedRows,
  tempDb,
  unwrap,
  updateRowForTest,
} from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import {
  fixtureRemote,
  startForgeFixture,
  type ForgeFixture,
} from "../forge/fixtures.js";
import { deliverTicket } from "./deliver.js";
import { sweepDeliveries } from "./sweep.js";
import {
  BRANCH,
  PROJECT,
  TICKET,
  git,
  makeRepo,
  T0,
  fakeGit,
  makeWorld,
  projectRows,
  remoteRef,
  secretsOf,
  strandOnRemote,
  type ProjectRows,
  type World,
} from "./testing/world.js";

// One ticket's delivery, end to end, against real local bare repositories and a local
// HTTP fixture for the forge. Nothing here reaches a network, and nothing here is a mock of our own
// code: the pushes are real git pushes and the pull requests are real HTTP.
//
// A test's remote is a **path**, which has no forge host, so the pull-request half is reached
// through `ctx.forgeRemoteOf` — the one documented test seam (lifecycle/context.ts). That the token
// is then NOT handed to git is itself asserted: a path is not https.

const TOKEN = "a-secret-forge-token";

let world: World | null = null;
let temp: { cleanup(): void } | null = null;
let fixture: ForgeFixture | null = null;

afterEach(async () => {
  world?.cleanup();
  world = null;
  temp?.cleanup();
  temp = null;
  await fixture?.close();
  fixture = null;
});

/** A temp database and a world over it. Seeding stays here: only a test may import the helpers. */
async function worldWith(over: Partial<World["ctx"]> = {}): Promise<World> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  temp = t;
  const w = makeWorld(t.db, clock, over);
  world = w;
  return w;
}

const seed = async (w: World, p: ProjectRows) => {
  unwrap(await seedRows(w.db, projectRows(p)));
};

/** A world whose forge is the local fixture, and whose store holds the forge token. */
async function forgeWorld() {
  const f = await startForgeFixture();
  fixture = f;
  const w = await worldWith({
    forgeFetch: f.fetchVia(),
    // One fixture repository per recorded remote, named after it: two repos never share a list.
    forgeRemoteOf: (url: string) =>
      fixtureRemote("an-owner", basename(url, ".git")),
    secrets: secretsOf({ FORGE_TOKEN_GITHUB: TOKEN }),
  });
  return { world: w, fixture: f };
}

/** A world with no forge at all: every remote is a plain path. */
const plainWorld = (secrets: Record<string, string> = {}) =>
  worldWith({ secrets: secretsOf(secrets) });

const deliveries = async (w: World) =>
  (unwrap(await dumpAllRows(w.db)).deliveries ?? []) as readonly Record<
    string,
    unknown
  >[];

const links = async (w: World) =>
  (unwrap(await dumpAllRows(w.db)).ticket_links ?? []) as readonly Record<
    string,
    unknown
  >[];

const ticketOf = async (w: World) =>
  (unwrap(await dumpAllRows(w.db)).tickets ?? [])[0] as
    Record<string, unknown> | undefined;

const requests = async (w: World) =>
  (unwrap(await dumpAllRows(w.db)).human_requests ?? []) as readonly Record<
    string,
    unknown
  >[];

const events = async (w: World) =>
  (unwrap(await dumpAllRows(w.db)).ticket_events ?? []) as readonly Record<
    string,
    unknown
  >[];

const run = (w: World) =>
  deliverTicket(w.ctx, TICKET, new AbortController().signal);

test("a single-repo project pushes its branch and records it", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "only");
  await seed(w, { repos: [repo], mode: "push" });

  const out = unwrap(await run(w));
  expect(out).toMatchObject({ pushed: 1, prs: 0, failed: null });
  expect(remoteRef(repo.remote)).toBe(repo.head);

  const rows = await deliveries(w);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ticket_id: TICKET,
    repo_id: "only",
    branch: BRANCH,
    head_sha: repo.head,
    state: "pushed",
    pr_url: null,
  });
  // A path remote has no host, and the row never holds a URL (§14).
  expect(rows[0]?.remote_host).toBeNull();
  expect(await links(w)).toHaveLength(0);
  expect((await ticketOf(w))?.pr_url).toBeNull();
});

test("a re-run pushes nothing new and writes nothing", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "twice");
  await seed(w, { repos: [repo], mode: "push" });
  unwrap(await run(w));
  const before = await deliveries(w);
  const audited = (unwrap(await dumpAllRows(w.db)).audit_log ?? []).length;

  const again = unwrap(await run(w));
  expect(again).toEqual({ pushed: 0, prs: 0, noop: true, failed: null });
  expect(await deliveries(w)).toEqual(before);
  expect(remoteRef(repo.remote)).toBe(repo.head);
  // Nothing was written at all: no row rewritten, and no second `supervisor.delivery` audit row.
  expect((unwrap(await dumpAllRows(w.db)).audit_log ?? []).length).toBe(
    audited,
  );
});

test("a new commit on the branch is delivered again, in place", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "moved");
  await seed(w, { repos: [repo], mode: "push" });
  unwrap(await run(w));

  git(repo.src, "commit", "-q", "--allow-empty", "-m", "more");
  git(
    repo.mirror,
    "fetch",
    repo.src,
    `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
  );
  const moved = git(repo.mirror, "rev-parse", BRANCH);

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1 });
  const rows = await deliveries(w);
  // One row per (ticket, repo), replaced in place: the unique index says so.
  expect(rows).toHaveLength(1);
  expect(rows[0]?.head_sha).toBe(moved);
  expect(remoteRef(repo.remote)).toBe(moved);
});

test("delivery_mode 'none' does nothing at all", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "quiet");
  await seed(w, { repos: [repo], mode: "none" });

  expect(unwrap(await run(w))).toEqual({
    pushed: 0,
    prs: 0,
    noop: true,
    failed: null,
  });
  expect(remoteRef(repo.remote)).toBeNull();
  expect(await deliveries(w)).toHaveLength(0);
  // The sweep does not even look at it.
  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 0,
    delivered: 0,
    failed: 0,
    budgetSpent: false,
  });
});

test("a ticket that has not reached the moment waits", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "early");
  await seed(w, {
    repos: [repo],
    mode: "push",
    when: "done",
    status: "qa_human",
  });
  expect(unwrap(await run(w)).noop).toBe(true);
  expect(remoteRef(repo.remote)).toBeNull();
  expect(await sweepDeliveries(w.ctx)).toMatchObject({ delivered: 0 });
});

// The one that must never regress: an unrelated branch of the same name is not ours to replace.
test("an unrelated remote branch fails loudly, clobbers nothing, and asks the operator", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "contested");
  const theirs = strandOnRemote(w.home.path, repo);
  await seed(w, { repos: [repo], mode: "push" });

  const out = unwrap(await run(w));
  expect(out.pushed).toBe(0);
  expect(out.failed?.class).toBe("conflict");
  expect(remoteRef(repo.remote)).toBe(theirs);

  const rows = await deliveries(w);
  expect(rows[0]).toMatchObject({ repo_id: "contested", state: "failed" });
  expect(String(rows[0]?.error)).toMatch(/not an ancestor/);

  const asked = await requests(w);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ kind: "delivery", ticket_id: TICKET });
  expect(String(asked[0]?.dedupe_key)).toMatch(/^delivery:ticket-1:contested/);
  // Asking twice for the same condition is refused by the key.
  unwrap(await run(w));
  expect(await requests(w)).toHaveLength(1);
});

test("a pull_request project opens one, links it and sets pr_url", async () => {
  const { world: w, fixture: f } = await forgeWorld();
  const repo = makeRepo(w.home.path, "lone");
  await seed(w, { repos: [repo], mode: "pull_request" });

  const out = unwrap(await run(w));
  expect(out).toMatchObject({ pushed: 1, prs: 1, failed: null });
  expect(remoteRef(repo.remote)).toBe(repo.head);

  const url = "https://forge.test/pull/1";
  expect((await deliveries(w))[0]).toMatchObject({
    state: "pr_open",
    pr_url: url,
    pr_number: 1,
    remote_host: null,
  });
  expect(await links(w)).toEqual([
    expect.objectContaining({ ticket_id: TICKET, kind: "pr", url }),
  ]);
  expect((await ticketOf(w))?.pr_url).toBe(url);

  // The pull request's title and body are compiled, and carry the ticket.
  const created = f.requests.find((r) => r.method === "POST");
  expect(JSON.parse(created?.body ?? "{}")).toMatchObject({
    title: "FRM-12 a change",
    head: BRANCH,
    base: "main",
  });
  expect(JSON.parse(created?.body ?? "{}").body).toContain("FRM-12");

  // The token went to the forge in one header — and NOT to git: the remote is a path, not https.
  expect(created?.authorization).toBe(`Bearer ${TOKEN}`);
  const config = git(repo.remote, "config", "--get-regexp", ".*").toLowerCase();
  expect(config).not.toContain(TOKEN.toLowerCase());
});

test("a re-run of a delivered pull request opens no second one", async () => {
  const { world: w, fixture: f } = await forgeWorld();
  const repo = makeRepo(w.home.path, "once");
  await seed(w, { repos: [repo], mode: "pull_request" });
  unwrap(await run(w));
  f.requests.length = 0;

  expect(unwrap(await run(w))).toMatchObject({ pushed: 0, prs: 0 });
  // Not one HTTP call: the recorded head and pull request are enough to know there is nothing to do.
  expect(f.requests).toHaveLength(0);
  expect(await links(w)).toHaveLength(1);
});

test("a submodule project delivers its submodules before the parent, and says so", async () => {
  const { world: w, fixture: f } = await forgeWorld();
  const parent = makeRepo(w.home.path, "super");
  const dep = makeRepo(w.home.path, "dep");
  await seed(w, {
    repos: [parent, dep],
    kind: "submodule",
    mode: "pull_request",
    submodulePaths: { dep: "deps/dep" },
  });

  const out = unwrap(await run(w));
  expect(out).toMatchObject({ pushed: 2, prs: 2 });
  expect(remoteRef(dep.remote)).toBe(dep.head);
  expect(remoteRef(parent.remote)).toBe(parent.head);

  // The dep's pull request is created first: its number is the lower one.
  const created = f.requests.filter((r) => r.method === "POST");
  expect(created).toHaveLength(2);
  expect(created[0]?.path).toBe("/repos/an-owner/dep/pulls");
  expect(created[1]?.path).toBe("/repos/an-owner/super/pulls");
  const parentBody = JSON.parse(created[1]?.body ?? "{}").body as string;
  // The parent's body describes the gitlink bump — which it can only do because the submodule was
  // delivered first and its pull request is already known.
  expect(parentBody).toContain("## Submodules");
  expect(parentBody).toContain("`deps/dep`");
  expect(parentBody).toContain(dep.head.slice(0, 12));
  expect(parentBody).toContain("https://forge.test/pull/1");

  // `tickets.pr_url` is the PARENT's, and both are linked.
  expect((await ticketOf(w))?.pr_url).toBe("https://forge.test/pull/2");
  expect((await links(w)).map((l) => l.url)).toEqual([
    "https://forge.test/pull/1",
    "https://forge.test/pull/2",
  ]);
});

test("a failing submodule stops the parent from being pushed", async () => {
  const w = await plainWorld();
  const parent = makeRepo(w.home.path, "super2");
  const dep = makeRepo(w.home.path, "dep2");
  strandOnRemote(w.home.path, dep);
  await seed(w, {
    repos: [parent, dep],
    kind: "submodule",
    mode: "push",
    submodulePaths: { dep2: "deps/dep2" },
  });

  const out = unwrap(await run(w));
  expect(out.failed?.class).toBe("conflict");
  // The parent's gitlinks would have pointed at a commit the remote does not have.
  expect(remoteRef(parent.remote)).toBeNull();
});

// Remove the fallback (the `FORGES.has(kind)` guard) and this fails: the job would try to open a
// pull request against a host it has no client for.
test("an unsupported host falls back to pushing, and the ticket's timeline says why", async () => {
  const w = await plainWorld({ FORGE_TOKEN_GITHUB: TOKEN });
  const repo = makeRepo(w.home.path, "elsewhere");
  await seed(w, { repos: [repo], mode: "pull_request" });

  const out = unwrap(await run(w));
  expect(out).toMatchObject({ pushed: 1, prs: 0, failed: null });
  expect(remoteRef(repo.remote)).toBe(repo.head);
  expect((await deliveries(w))[0]).toMatchObject({
    state: "pushed",
    pr_url: null,
  });
  expect((await ticketOf(w))?.pr_url).toBeNull();

  const note = (await events(w)).find((e) => e.kind === "delivery");
  expect(String(note?.payload_json)).toMatch(/not a forge Bayon can open/);
});

test("no token for the forge also falls back, naming the secret and never a value", async () => {
  const f = await startForgeFixture();
  fixture = f;
  const w = await worldWith({
    forgeFetch: f.fetchVia(),
    forgeRemoteOf: (url: string) =>
      fixtureRemote("an-owner", basename(url, ".git")),
    secrets: secretsOf(),
  });
  const repo = makeRepo(w.home.path, "tokenless");
  await seed(w, { repos: [repo], mode: "pull_request" });

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, prs: 0 });
  expect(f.requests).toHaveLength(0);
  const note = (await events(w)).find((e) => e.kind === "delivery");
  expect(String(note?.payload_json)).toContain("FORGE_TOKEN_GITHUB");
});

test("a repo with no recorded remote is a failure, not an invented one", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "homeless");
  // No origin_url: the job has nowhere to deliver it, and never guesses one from a worktree.
  await seed(w, {
    repos: [repo],
    mode: "push",
    origins: { homeless: null },
  });

  const out = unwrap(await run(w));
  expect(out.failed?.message).toMatch(/no push_url or origin_url recorded/);
  expect((await deliveries(w))[0]).toMatchObject({ state: "failed" });
});

test("the sweep delivers each due ticket and pages from where it left off", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "swept");
  await seed(w, { repos: [repo], mode: "push" });

  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 1,
    delivered: 1,
    failed: 0,
    budgetSpent: false,
  });
  expect(remoteRef(repo.remote)).toBe(repo.head);
  // A second pass looks again and finds nothing to do.
  expect(await sweepDeliveries(w.ctx)).toEqual({
    looked: 1,
    delivered: 0,
    failed: 0,
    budgetSpent: false,
  });
  expect(
    w.logs.some((l) => l.msg.includes("reached its project's remote")),
  ).toBe(true);
  expect(PROJECT).toBe("ws-1");
});

// ─── an earlier change review round ──────────────────────────────────────────────────────────────────
// A `git` of our own on PATH (testing/world.ts): a real repository cannot be made to print a
// secret on demand, and an auth failure that echoes a remote's userinfo would need a server.

const URL_PASSWORD = "a-url-password";
const CREDENTIALLED = `https://ops:${URL_PASSWORD}@forge.test/an-owner/a-repo.git`;

/** A world whose git is ours, whose remote carries a credential, and whose store holds the token. */
async function fakeGitWorld(failWith?: string) {
  const w = await worldWith({
    forgeRemoteOf: () => fixtureRemote(),
    secrets: secretsOf({ FORGE_TOKEN_GITHUB: TOKEN }),
  });
  const git = fakeGit(w.home.path, failWith === undefined ? {} : { failWith });
  const ctx = { ...w.ctx, path: git.dir };
  return { w: { ...w, ctx }, git };
}

const named = (w: World, id: string) =>
  seed(w, {
    repos: [makeRepo(w.home.path, id)],
    mode: "push",
    origins: { [id]: CREDENTIALLED },
  });

test("a git failure naming the token and the remote's credential is redacted everywhere", async () => {
  const { w } = await fakeGitWorld(
    `fatal: unable to access '${CREDENTIALLED}/': The requested URL returned error: 403 Forbidden (token ${TOKEN})`,
  );
  await named(w, "leaky");

  const swept = await sweepDeliveries(w.ctx);
  expect(swept).toMatchObject({ failed: 1, delivered: 0 });

  const secrets = [TOKEN, URL_PASSWORD];
  // 1. the row.
  const row = (await deliveries(w))[0];
  expect(row).toMatchObject({ state: "failed" });
  const stored = String(row?.error);
  expect(stored).toContain("<redacted>");
  // 2. the ticket's timeline. 3. the operator's request. 4. the supervisor's log.
  const timeline = String(
    (await events(w)).find((e) => e.kind === "delivery")?.payload_json,
  );
  const asked = String((await requests(w))[0]?.context_md);
  const logged = JSON.stringify(w.logs);
  for (const secret of secrets) {
    for (const [where, text] of [
      ["deliveries.error", stored],
      ["the ticket event", timeline],
      ["the human request", asked],
      ["the log", logged],
    ] as const) {
      expect(text, `${secret} in ${where}`).not.toContain(secret);
    }
  }
  expect(timeline).toContain("<redacted>");
  expect(asked).toContain("<redacted>");
  expect(logged).toContain("<redacted>");
  // The operator still learns which repository refused, and why.
  expect(stored).toContain("403");
  expect(stored).toContain("forge.test");
});

test("push mode on a forge host is given the credential, with no pull request in sight", async () => {
  const { w, git } = await fakeGitWorld();
  await named(w, "private-push");

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, prs: 0 });
  const lines = git.lines();
  // The token reached git's environment, and the helper that reads it reached its argv.
  expect(lines).toContain(`TOKEN:${TOKEN}`);
  expect(lines.some((l) => l.startsWith("ARGS:") && l.includes("push"))).toBe(
    true,
  );
  expect(
    lines.some((l) => l.startsWith("ARGS:") && l.includes("credential.helper")),
  ).toBe(true);
  // And nowhere else: not in the argv, not in a URL.
  expect(lines.filter((l) => l.startsWith("ARGS:")).join("\n")).not.toContain(
    TOKEN,
  );
});

test("a transport failure files no operator request; an auth failure files one", async () => {
  const transport = await fakeGitWorld(
    "fatal: unable to access 'https://forge.test/a/b.git/': Could not resolve host: forge.test",
  );
  await named(transport.w, "blip");
  const blip = unwrap(await run(transport.w));
  expect(blip.failed?.retryable).toBe(true);
  expect(await requests(transport.w)).toHaveLength(0);
  transport.w.cleanup();

  const auth = await fakeGitWorld(
    "fatal: Authentication failed for 'https://forge.test/a/b.git/'",
  );
  await named(auth.w, "denied");
  const denied = unwrap(await run(auth.w));
  expect(denied.failed?.retryable).toBe(false);
  expect(await requests(auth.w)).toHaveLength(1);
});

test("a pull request that fails after the push records the commit that is really there", async () => {
  const { world: w, fixture: f } = await forgeWorld();
  const repo = makeRepo(w.home.path, "half");
  await seed(w, { repos: [repo], mode: "pull_request" });
  // The list is refused, so the push lands and the request does not.
  f.overrides.push({
    status: 404,
    body: JSON.stringify({ message: "Not Found" }),
  });

  const out = unwrap(await run(w));
  expect(out.failed?.retryable).toBe(false);
  // The branch IS on the remote.
  expect(remoteRef(repo.remote)).toBe(repo.head);
  const rows = await deliveries(w);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ state: "failed", head_sha: repo.head });
  expect(rows[0]?.pr_url).toBeNull();
});

// ─── 039: a push target that is not the origin ───────────────────────────────────────────────
// A folder project's origin_url is the owner's own checkout; its push_url is where the work goes.

test("a repo with a push_url is pushed there, and its origin is left alone", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "folder");
  // The owner's checkout, standing in for the folder the project was created from.
  const checkout = `${w.home.path}/checkouts/folder.git`;
  git(w.home.path, "init", "-q", "--bare", checkout);
  await seed(w, {
    repos: [repo],
    mode: "push",
    origins: { folder: checkout },
    pushUrls: { folder: repo.remote },
  });

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, failed: null });
  expect(remoteRef(repo.remote)).toBe(repo.head);
  expect(remoteRef(checkout)).toBeNull();
});

/** A world whose git is ours and whose forge is decided by the REAL host table: no seam. */
async function realHostWorld() {
  const w = await worldWith({
    secrets: secretsOf({ FORGE_TOKEN_GITHUB: TOKEN }),
  });
  const fake = fakeGit(w.home.path);
  return { w: { ...w, ctx: { ...w.ctx, path: fake.dir } }, git: fake };
}

test("a push_url on a host with no forge kind is given no token, even with one in the store", async () => {
  const { w, git: fake } = await realHostWorld();
  const target = "https://forge.test/an-owner/a-repo.git";
  await seed(w, {
    repos: [makeRepo(w.home.path, "unknown-host")],
    mode: "push",
    origins: { "unknown-host": "/src/unknown-host" },
    pushUrls: { "unknown-host": target },
  });

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, failed: null });
  const lines = fake.lines();
  // git was pointed at the push target, never at the folder…
  const argv = lines.filter((l) => l.startsWith("ARGS:")).join("\n");
  expect(argv).toContain(target);
  expect(argv).not.toContain("/src/unknown-host");
  // …and was handed no credential at all: the host is not in the forge table.
  expect(lines.filter((l) => l.startsWith("TOKEN:"))).not.toHaveLength(0);
  expect(lines.every((l) => !l.startsWith("TOKEN:") || l === "TOKEN:")).toBe(
    true,
  );
  expect((await deliveries(w))[0]).toMatchObject({
    state: "pushed",
    remote_host: "forge.test",
  });
});

test("an https push_url on a known forge host is what earns the token, not the origin", async () => {
  const { w, git: fake } = await realHostWorld();
  await seed(w, {
    repos: [makeRepo(w.home.path, "known-host")],
    mode: "push",
    origins: { "known-host": "/src/known-host" },
    pushUrls: { "known-host": "https://github.com/an-owner/a-repo.git" },
  });

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, failed: null });
  expect(fake.lines()).toContain(`TOKEN:${TOKEN}`);
  expect((await deliveries(w))[0]?.remote_host).toBe("github.com");
});

// ─── M8.1 review, HIGH 1: a moved push target is a new delivery ─────────────────────────────

/** The git calls that reach a remote: what a finished repo must never make. */
const remoteCalls = (lines: readonly string[]) =>
  lines.filter(
    (l) => l.startsWith("ARGS:") && /\b(push|ls-remote|fetch)\b/.test(l),
  );

const moveTarget = async (w: World, repoId: string, pushUrl: string) =>
  unwrap(await updateRowForTest(w.db, "repos", repoId, { push_url: pushUrl }));

test("a push_url moved after delivery pushes to the new target on the next pass", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "moving");
  await seed(w, {
    repos: [repo],
    mode: "push",
    pushUrls: { moving: repo.remote },
  });
  unwrap(await run(w));
  expect((await deliveries(w))[0]?.remote_url).toBe(repo.remote);

  const next = `${w.home.path}/remotes/moving-next.git`;
  git(w.home.path, "init", "-q", "--bare", next);
  await moveTarget(w, "moving", next);

  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, failed: null });
  expect(remoteRef(next)).toBe(repo.head);
  const rows = await deliveries(w);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ remote_url: next, head_sha: repo.head });
});

test("two repositories on one host are two targets: a moved path re-pushes and re-opens", async () => {
  const f = await startForgeFixture();
  fixture = f;
  const w = await worldWith({
    forgeFetch: f.fetchVia(),
    forgeRemoteOf: (url: string) =>
      fixtureRemote("an-owner", basename(url, ".git")),
    secrets: secretsOf({ FORGE_TOKEN_GITHUB: TOKEN }),
  });
  const repo = makeRepo(w.home.path, "renamed");
  // Same parent directory — the "host" — different repository names.
  const first = `${w.home.path}/remotes/first.git`;
  const second = `${w.home.path}/remotes/second.git`;
  git(w.home.path, "init", "-q", "--bare", first);
  git(w.home.path, "init", "-q", "--bare", second);
  await seed(w, {
    repos: [repo],
    mode: "pull_request",
    pushUrls: { renamed: first },
  });
  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, prs: 1 });
  const opened = f.requests.length;

  await moveTarget(w, "renamed", second);
  expect(unwrap(await run(w))).toMatchObject({ pushed: 1, prs: 1 });
  expect(remoteRef(second)).toBe(repo.head);
  expect(f.requests.length).toBeGreaterThan(opened);
  expect((await deliveries(w))[0]).toMatchObject({
    remote_url: second,
    state: "pr_open",
  });
});

test("an unchanged target is still a no-op: no git and no HTTP", async () => {
  const f = await startForgeFixture();
  fixture = f;
  const w = await worldWith({
    forgeFetch: f.fetchVia(),
    forgeRemoteOf: (url: string) =>
      fixtureRemote("an-owner", basename(url, ".git")),
    secrets: secretsOf({ FORGE_TOKEN_GITHUB: TOKEN }),
  });
  const repo = makeRepo(w.home.path, "steady");
  await seed(w, {
    repos: [repo],
    mode: "pull_request",
    pushUrls: { steady: repo.remote },
  });
  unwrap(await run(w));
  const requests = f.requests.length;

  // A git that records every call and answers the mirror's head: a finished repo reads its own
  // mirror and nothing else — no ls-remote, no push.
  const fake = fakeGit(w.home.path, { sha: repo.head });
  const quiet = { ...w, ctx: { ...w.ctx, path: fake.dir } };
  expect(unwrap(await run(quiet))).toEqual({
    pushed: 0,
    prs: 0,
    noop: true,
    failed: null,
  });
  expect(fake.lines().some((l) => l.includes("rev-parse"))).toBe(true);
  expect(remoteCalls(fake.lines())).toEqual([]);
  expect(f.requests.length).toBe(requests);
});

test("a delivery recorded before 039 (no remote_url) went to origin_url: no re-push", async () => {
  const w = await plainWorld();
  const repo = makeRepo(w.home.path, "legacy");
  await seed(w, { repos: [repo], mode: "push" });
  unwrap(await run(w));
  const row = (await deliveries(w))[0];
  // As 038 wrote it: no target recorded.
  unwrap(
    await updateRowForTest(w.db, "deliveries", String(row?.id), {
      remote_url: null,
    }),
  );
  const fake = fakeGit(w.home.path, { sha: repo.head });
  const quiet = { ...w, ctx: { ...w.ctx, path: fake.dir } };
  expect(unwrap(await run(quiet))).toMatchObject({ pushed: 0, noop: true });
  expect(remoteCalls(fake.lines())).toEqual([]);
});
