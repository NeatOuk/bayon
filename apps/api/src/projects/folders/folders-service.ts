import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_GIT_AUTHOR_KEY,
  AgentGitAuthor,
  DEFAULT_AGENT_GIT_AUTHOR,
  err,
  isInsideRoot,
  ok,
  type GitAuthor,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { addLocalRoot, appendAudit } from "@bayon/db/api";
import type {
  FolderAllowRequest,
  FolderAllowed,
  FolderCheck,
} from "@bayon/proto";
import { runGit, type GitRunner } from "../../tickets/git-facts.js";
import {
  allowCommand,
  notAllowedMessage,
  placeOf,
  type FolderPlace,
} from "../local-repo.js";
import { folderState, initFolder } from "./folder-state.js";
import { isLocalRequest, type PeerRequest } from "./local-request.js";

// `/folders`: what the New project form learns about a folder before it
// creates anything, and its two actions. `check` writes nothing. `allow` appends one folder to
// `projects.local_roots` and is the controller's to refuse unless the request is from a browser on
// this host (local-request.ts) — the service trusts the flag it is handed, and nothing else calls
// it. `init` works only inside an allowed folder, only on a folder without a commit, and is
// audited. Messages are plain words: what happened, then the one thing to do.

/** Who acts through the bearer: the operator (§12.1). */
const OPERATOR = "operator";
/** Written after git ran, with what it did (or why it failed). */
export const FOLDER_INIT_ACTION = "project.folder_init";
/** Written before git runs: the intent, so an attempt that dies midway still left a trace. */
export const FOLDER_INIT_START_ACTION = "project.folder_init.start";

export interface FoldersServiceDeps {
  readonly db: Db;
  readonly git?: GitRunner;
  /** The operator's home folder; tests hand in their own. */
  readonly home?: string;
  /** FRM_HOME: never allowed, nor anything inside it or above it. */
  readonly frmHome?: string | null;
  /** The host-only key the GUI's proxy sends (local-key.ts); null: nothing is local. */
  readonly localKey?: string | null;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const isAbsolute = (path: string): boolean => path.startsWith("/");

const NOT_ABSOLUTE =
  "That is not a full folder path. Type it from the top, starting with /, for example /Users/you/projects/app.";

async function isDirectory(path: string | null): Promise<boolean> {
  if (path === null) return false;
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

const realOr = (path: string): Promise<string> =>
  realpath(path).catch(() => path);

export class FoldersService {
  readonly #db: Db;
  readonly #git: GitRunner;
  readonly #home: string;
  readonly #frmHome: string | null;
  readonly #localKey: string | null;

  constructor(deps: FoldersServiceDeps) {
    this.#db = deps.db;
    this.#git = deps.git ?? runGit();
    this.#home = deps.home ?? homedir();
    this.#frmHome = deps.frmHome ?? null;
    this.#localKey = deps.localKey ?? null;
  }

  /** Whether `request` is from a browser on this host (local-request.ts). */
  isLocal(request: PeerRequest): boolean {
    return isLocalRequest(request, this.#localKey);
  }

  /**
   * Why `root` may never be allowed from the GUI, or null: `/`, the home folder or above it; FRM_HOME
   * (Bayon's database, keys and logs), inside it or above it; `~/.ssh` and `~/Library` or inside them.
   */
  async #refusedRoot(root: string): Promise<string | null> {
    const home = await realOr(this.#home);
    if (root === "/" || isInsideRoot(home, root)) {
      return "your whole home folder or more";
    }
    if (this.#frmHome !== null) {
      const frm = await realOr(this.#frmHome);
      if (isInsideRoot(root, frm) || isInsideRoot(frm, root)) {
        return "Bayon's own folder, where its database and keys live";
      }
    }
    for (const name of [".ssh", "Library"]) {
      if (isInsideRoot(root, await realOr(join(home, name)))) {
        return `your ~/${name} folder`;
      }
    }
    return null;
  }

  async #place(path: string): Promise<Result<FolderPlace>> {
    return isAbsolute(path) ? placeOf(this.#db, path) : invalid(NOT_ABSOLUTE);
  }

  /** What `path` is, as the New project form shows it. */
  async check(path: string, local: boolean): Promise<Result<FolderCheck>> {
    const place = await this.#place(path);
    if (!place.ok) return place;
    const { real, root } = place.value;
    const base = {
      path,
      local,
      branch: null,
      parent: null,
      allow_command: allowCommand(path),
    };
    const there = await isDirectory(real);
    if (root === null) {
      // To a browser elsewhere a missing folder and an existing one read the same: no oracle.
      if (!local) return ok({ ...base, state: "not_allowed", real_path: null });
      if (!there || real === null) {
        return ok({ ...base, state: "missing", real_path: null });
      }
      const parent = dirname(real);
      return ok({
        ...base,
        state: "not_allowed",
        real_path: real,
        parent: (await this.#refusedRoot(parent)) === null ? parent : null,
      });
    }
    if (!there || real === null) {
      return ok({ ...base, state: "missing", real_path: null });
    }
    const facts = await folderState(this.#git, real, root);
    return ok({ ...base, ...facts, real_path: real });
  }

  /**
   * Appends the folder (or its parent) to the allowed folders, audited as the operator's. `local`
   * is the controller's finding; anything else is refused with the command to run instead.
   */
  async allow(
    body: FolderAllowRequest,
    local: boolean,
  ): Promise<Result<FolderAllowed>> {
    const place = await this.#place(body.path);
    if (!place.ok) return place;
    const { real } = place.value;
    if (!local) {
      return invalid(
        `Only a browser on the machine Bayon runs on can allow a folder. ` +
          `From here, run this in a terminal on that machine, in the Bayon folder: ${allowCommand(body.path)}`,
      );
    }
    if (real === null || !(await isDirectory(real))) {
      return invalid(
        `There is no folder at ${JSON.stringify(body.path)}. Check the path, or create the folder first.`,
      );
    }
    const root = body.scope === "parent" ? dirname(real) : real;
    if (root !== body.expect_root) {
      return invalid(
        `The folder changed since you confirmed: it is now ${JSON.stringify(root)}, not ${JSON.stringify(body.expect_root)}. Check it again, then confirm.`,
      );
    }
    const refused = await this.#refusedRoot(root);
    if (refused !== null) {
      return invalid(
        `Allowing ${JSON.stringify(root)} would let agents use ${refused}. Allow a folder of your project's own instead.`,
      );
    }
    const added = await addLocalRoot(this.#db, root, OPERATOR, {
      path: body.path,
      scope: body.scope,
    });
    return added.ok
      ? ok({ ...added.value, roots: [...added.value.roots] })
      : added;
  }

  async #author(): Promise<Result<GitAuthor>> {
    const rows = await getSettings(this.#db, [AGENT_GIT_AUTHOR_KEY]);
    if (!rows.ok) return rows;
    const parsed = AgentGitAuthor.safeParse(
      rows.value.get(AGENT_GIT_AUTHOR_KEY) ?? DEFAULT_AGENT_GIT_AUTHOR,
    );
    return ok(
      parsed.success
        ? parsed.data
        : AgentGitAuthor.parse(DEFAULT_AGENT_GIT_AUTHOR),
    );
  }

  /**
   * An allowed folder with no commit made a git repository with one empty commit,
   * audited; then the check again. Never a folder with a commit, never one outside the roots.
   */
  async init(path: string, local: boolean): Promise<Result<FolderCheck>> {
    const place = await this.#place(path);
    if (!place.ok) return place;
    const { real, root } = place.value;
    if (root === null || real === null) {
      return invalid(notAllowedMessage(path, allowCommand(path)));
    }
    if (!(await isDirectory(real))) {
      return invalid(
        `There is no folder at ${JSON.stringify(path)}. Check the path, or create the folder first.`,
      );
    }
    const author = await this.#author();
    if (!author.ok) return author;
    const target = { actor: OPERATOR, target_kind: "folder", target_id: real };
    const intent = await appendAudit(this.#db, {
      ...target,
      action: FOLDER_INIT_START_ACTION,
      payload: { path },
    });
    if (!intent.ok) return intent;
    const done = await initFolder(this.#git, real, root, author.value);
    const audit = await appendAudit(this.#db, {
      ...target,
      action: FOLDER_INIT_ACTION,
      payload: done.ok
        ? {
            path,
            outcome: "done",
            created_repo: done.value.createdRepo,
            branch: done.value.branch,
            commit: done.value.commit,
          }
        : { path, outcome: "refused", reason: done.error.message },
    });
    if (!done.ok) return done;
    if (!audit.ok) return audit;
    return this.check(path, local);
  }
}
