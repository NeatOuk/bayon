import type { CiCheckState, ForgeKind, ForgeRemote, Result } from "@bayon/core";
import type { ForgeHttp } from "./http.js";

// The forge layer's shape (spike §1.4). Three things are asked of a forge: give this
// branch a pull request, or tell me the one it already has; say where one of them stands
// now — open, merged or closed; and list the checks reported on a commit.
//
// A kind is chosen by a remote's host (core `forgeRemote`), never by a project, an org or a
// deployment. Adding a second kind is a file beside `github.ts` and a line in `FORGES`.

export interface PullRequestAsk {
  readonly remote: ForgeRemote;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface OpenedPullRequest {
  readonly url: string;
  readonly number: number;
  /** False when this call created it: what the ticket's timeline says happened. */
  readonly reused: boolean;
}

/** A pull request's state as the forge reports it now. */
export interface PullRequestState {
  readonly state: "open" | "closed";
  /** True once merged; a merged request is also `closed`. */
  readonly merged: boolean;
  /** Epoch-millis, as the forge reported it; null until merged. */
  readonly merged_at: number | null;
  /** The login that merged it — a name, never a credential; null until merged (or unknown). */
  readonly merged_by: string | null;
  readonly head_sha: string;
}

/**
 * One check reported on a commit: a check run or a commit status, normalized. `name` is
 * cleaned (core `ciCheckName`); `url` is kept only when it is a page on the remote's own forge.
 */
export interface ForgeCheck {
  readonly name: string;
  readonly state: CiCheckState;
  readonly url: string | null;
}

export interface Forge {
  readonly kind: ForgeKind;
  /**
   * The open pull request for `head` → `base`, opening one only if the forge has none. Reuse is
   * asked for **first**, so a retry after a half-failed run never opens a second request — the
   * forge, not a local row, is the authority on what exists.
   */
  openPullRequest(
    http: ForgeHttp,
    ask: PullRequestAsk,
  ): Promise<Result<OpenedPullRequest>>;
  /**
   * Pull request `number` on `remote` as it is now: what the pull-request sweep polls.
   * A read: nothing on the forge changes.
   */
  getPullRequest(
    http: ForgeHttp,
    remote: ForgeRemote,
    number: number,
  ): Promise<Result<PullRequestState>>;
  /**
   * Every check reported on commit `sha` of `remote`: what the CI sweep reads for a
   * `qa_harness` gate that waits on CI. All of them or an error — never a partial list, which could
   * hide a failure. A read: nothing on the forge changes.
   */
  listChecks(
    http: ForgeHttp,
    remote: ForgeRemote,
    sha: string,
  ): Promise<Result<readonly ForgeCheck[]>>;
}
