import {
  checkPushUrl,
  ok,
  stripPushUrlCredentials,
  type Result,
} from "@bayon/core";
import { listProjects, type Db } from "@bayon/db";
import type { NewProject } from "@bayon/db/api";
import type { PushTargetProposal } from "@bayon/proto";
import { runGit, type GitRunner } from "../tickets/git-facts.js";
import { allowedLocalRepo } from "./local-repo.js";

// A folder project's push target (migration 039): the remote the folder itself works against, read
// from its own `origin` — at creation, and when the operator presses Detect. Never at push time:
// the supervisor reads `repos.push_url` and nothing else (rule).
//
// `git remote get-url origin` runs as argv through `runGit` (no shell, the executors' safe flags, a
// minimal environment, a timeout). Whatever it prints has any credential taken out before anything
// else sees it, and is then held to core's `checkPushUrl`: a remote no push can reach (a path, an
// http:// URL) is no target, with a warning saying so.

const GIT_TIMEOUT_MS = 10_000;

/** What one folder's origin gave: the target to record (or null), and what the operator is told. */
export interface DetectedPush {
  readonly push_url: string | null;
  readonly warning: string | null;
}

const NONE: DetectedPush = { push_url: null, warning: null };

/** git's own words for a folder with no `origin` remote: not a problem, just nothing to record. */
const NO_SUCH_REMOTE = /no such remote/i;

/**
 * `dir`'s `origin`, as a push target: credentials removed, checked, or null with the reason. No
 * origin at all is null with no warning — a folder that pushes nowhere yet is ordinary.
 */
export async function detectPushUrl(
  git: GitRunner,
  dir: string,
): Promise<DetectedPush> {
  const run = await git(dir, ["remote", "get-url", "origin"], GIT_TIMEOUT_MS);
  if (!run.ok) {
    // git's words are not repeated: they could name the remote, and so its credential.
    return NO_SUCH_REMOTE.test(run.detail)
      ? NONE
      : {
          push_url: null,
          warning: `${dir}: its origin could not be read, so no push target was recorded.`,
        };
  }
  const raw = run.stdout.trim();
  if (raw === "") return NONE;
  const { url, stripped } = stripPushUrlCredentials(raw);
  const checked = checkPushUrl(url);
  if (!checked.ok) {
    return {
      push_url: null,
      warning: `${dir}: its origin ${JSON.stringify(url)} is not an https://, ssh:// or git@host:path remote, so no push target was recorded.`,
    };
  }
  return {
    push_url: checked.value,
    warning: stripped
      ? `${dir}: its origin carried credentials; they were removed and not stored. Store the forge token in the host secret store instead.`
      : null,
  };
}

/** Every repo of a folder project: the primary's folder, and each submodule's by its path. */
export interface FolderPushTargets {
  readonly primary: DetectedPush;
  readonly submodules: ReadonlyMap<string, DetectedPush>;
}

/** The folder's own origin and each submodule checkout's own origin, read one after another. */
export async function detectFolderPushTargets(
  git: GitRunner,
  root: string,
  submodules: readonly { readonly path: string; readonly origin: string }[],
): Promise<FolderPushTargets> {
  const primary = await detectPushUrl(git, root);
  const found = new Map<string, DetectedPush>();
  for (const s of submodules) {
    found.set(s.path, await detectPushUrl(git, s.origin));
  }
  return { primary, submodules: found };
}

/** Each warning a detection produced, primary first. */
export const warningsOf = (t: FolderPushTargets): string[] =>
  [t.primary, ...t.submodules.values()].flatMap((d) =>
    d.warning === null ? [] : [d.warning],
  );

/** `project` with each repo's detected push target on its row; a repo with none gets no column. */
export function withPushUrls(
  project: NewProject,
  targets: FolderPushTargets,
): NewProject {
  const pushOf = (d: DetectedPush | undefined) =>
    d === undefined || d.push_url === null ? {} : { push_url: d.push_url };
  return {
    ...project,
    repo: { ...project.repo, ...pushOf(targets.primary) },
    submodules: project.submodules.map((s) => ({
      ...s,
      repo: {
        ...s.repo,
        ...pushOf(targets.submodules.get(s.workspaceRepo.submodule_path ?? "")),
      },
    })),
  };
}

/** A folder repo: its origin_url is an absolute path (local-project.ts records the real one). */
const isFolder = (origin: string | null): origin is string =>
  origin !== null && origin.startsWith("/");

/**
 * `POST /projects/:id/push-targets/detect`: each of the project's repos with its stored target and
 * what its folder's origin proposes now. Writes nothing. A folder is held to `projects.local_roots`
 * again first — the allowed folders may have changed since the project was created, and git is run
 * in nothing they do not allow. An unknown project is `not_found`.
 */
export async function detectProjectPushTargets(
  db: Db,
  workspaceId: string,
  git: GitRunner = runGit(),
): Promise<Result<PushTargetProposal[]>> {
  const listed = await listProjects(db);
  if (!listed.ok) return listed;
  const project = listed.value.find((p) => p.workspace.id === workspaceId);
  if (project === undefined) {
    return {
      ok: false,
      error: {
        class: "not_found",
        message: `project ${workspaceId} does not exist`,
        retryable: false,
      },
    };
  }
  const repos = project.repos.toSorted(
    (a, b) =>
      (a.submodule_path === null ? 0 : 1) -
        (b.submodule_path === null ? 0 : 1) ||
      (a.submodule_path ?? "").localeCompare(b.submodule_path ?? ""),
  );
  const proposals: PushTargetProposal[] = [];
  for (const repo of repos) {
    proposals.push({
      repo_id: repo.id,
      submodule_path: repo.submodule_path,
      push_url: repo.push_url,
      ...(await proposalFor(db, git, repo.origin_url)),
    });
  }
  return ok(proposals);
}

async function proposalFor(
  db: Db,
  git: GitRunner,
  origin: string | null,
): Promise<{ detected: string | null; warning: string | null }> {
  if (!isFolder(origin)) {
    return {
      detected: null,
      warning:
        origin === null
          ? "this repo has no origin recorded, so there is no folder to read."
          : "this repo was not created from a folder: its origin already is its remote.",
    };
  }
  const allowed = await allowedLocalRepo(db, origin);
  if (!allowed.ok) return { detected: null, warning: allowed.error.message };
  const found = await detectPushUrl(git, allowed.value);
  return {
    detected: found.push_url,
    warning:
      found.warning ??
      (found.push_url === null
        ? `${allowed.value} has no origin remote.`
        : null),
  };
}
