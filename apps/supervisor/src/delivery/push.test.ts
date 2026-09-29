import { FakeClock } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { deliverableBranch, pushBranch } from "./push.js";
import {
  BRANCH,
  T0,
  git,
  makeRepo,
  remoteRef,
  strandOnRemote,
  tempHome,
  type RepoOnDisk,
} from "./testing/world.js";

// The push half of delivery (spike §1.3), against real local bare repositories. Nothing
// here touches a network, and nothing here is allowed to lose a commit: the last test is the one
// that matters — an unrelated branch of the same name on the remote must stop the push, not be
// overwritten by it.

const home = tempHome("frm-push-");
afterAll(() => home.cleanup());

const ctx = {
  settings: DEFAULT_SETTINGS,
  clock: new FakeClock(T0),
  path: process.env.PATH ?? "/usr/bin:/bin",
};

const ask = (repo: RepoOnDisk, over: Record<string, unknown> = {}) => ({
  mirrorPath: repo.mirror,
  remoteUrl: repo.remote,
  branch: BRANCH,
  token: null,
  signal: new AbortController().signal,
  what: `delivering ${repo.id}`,
  ...over,
});

const unwrapPush = (r: Awaited<ReturnType<typeof pushBranch>>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

test("only a session's own frm/ branch is deliverable", () => {
  expect(deliverableBranch("frm/01J0")).toBe(true);
  for (const bad of [
    "main",
    "detached@abc123",
    "frm/../etc",
    "frm/a b",
    "frm/a:b",
    "frm/a*",
  ]) {
    expect(deliverableBranch(bad), bad).toBe(false);
  }
});

test("a remote with no such branch gets the branch", async () => {
  const repo = makeRepo(home.path, "fresh");
  expect(remoteRef(repo.remote)).toBeNull();
  expect(unwrapPush(await pushBranch(ctx, ask(repo)))).toEqual({
    kind: "pushed",
    head: repo.head,
  });
  expect(remoteRef(repo.remote)).toBe(repo.head);
});

test("a second push of the same commit sends nothing: the remote already has it", async () => {
  const repo = makeRepo(home.path, "again");
  expect(unwrapPush(await pushBranch(ctx, ask(repo))).kind).toBe("pushed");
  expect(unwrapPush(await pushBranch(ctx, ask(repo)))).toEqual({
    kind: "already",
    head: repo.head,
  });
});

test("a remote branch that is an ancestor fast-forwards", async () => {
  const repo = makeRepo(home.path, "ff");
  unwrapPush(await pushBranch(ctx, ask(repo)));
  // One more commit on the source, published into the mirror as a session's would be.
  git(repo.src, "commit", "-q", "--allow-empty", "-m", "more work");
  git(
    repo.mirror,
    "fetch",
    repo.src,
    `refs/heads/${BRANCH}:refs/heads/${BRANCH}`,
  );
  const moved = git(repo.mirror, "rev-parse", BRANCH);
  expect(moved).not.toBe(repo.head);
  expect(unwrapPush(await pushBranch(ctx, ask(repo)))).toEqual({
    kind: "pushed",
    head: moved,
  });
  expect(remoteRef(repo.remote)).toBe(moved);
});

// The one that must never regress. Remove the ancestor check or add a `--force` and this fails.
test("an unrelated commit on the remote's branch fails loudly and is left alone", async () => {
  const repo = makeRepo(home.path, "stranger");
  const theirs = strandOnRemote(home.path, repo);
  const pushed = await pushBranch(ctx, ask(repo));
  expect(pushed.ok).toBe(false);
  if (pushed.ok) return;
  expect(pushed.error.class).toBe("conflict");
  expect(pushed.error.message).toContain(theirs.slice(0, 12));
  expect(pushed.error.message).toMatch(/not an ancestor/);
  // Untouched: their commit is still what the remote has.
  expect(remoteRef(repo.remote)).toBe(theirs);
});

test("a branch the mirror does not have is refused before anything is sent", async () => {
  const repo = makeRepo(home.path, "missing");
  const pushed = await pushBranch(ctx, ask(repo, { branch: "frm/nope" }));
  expect(pushed.ok).toBe(false);
  if (pushed.ok) return;
  expect(pushed.error.message).toMatch(/is not in its mirror/);
  expect(remoteRef(repo.remote, "frm/nope")).toBeNull();
});

test("a branch that is not a session's is refused, and a program-transport remote too", async () => {
  const repo = makeRepo(home.path, "refused");
  const branch = await pushBranch(ctx, ask(repo, { branch: "main" }));
  expect(branch.ok).toBe(false);
  if (!branch.ok) expect(branch.error.message).toMatch(/not a session's frm/);

  const url = await pushBranch(
    ctx,
    ask(repo, { remoteUrl: "ext::sh -c payload" }),
  );
  expect(url.ok).toBe(false);
  if (!url.ok) expect(url.error.message).toMatch(/program transport/);
});
