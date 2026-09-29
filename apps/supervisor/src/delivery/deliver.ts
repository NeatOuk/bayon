import {
  excerpt,
  forgeTokenSecret,
  opensPullRequests,
  pullRequestBody,
  pullRequestTitle,
  pushTargetOf,
  remoteHost,
  stripPushUrlCredentials,
  type DeliveredSubmodule,
  type ForgeRemote,
  type FrmError,
  type Result,
} from "@bayon/core";
import { deliveryPlan, type DeliveryPlan, type DeliveryRepo } from "@bayon/db";
import {
  commitDelivery,
  insertSystemHumanRequest,
  type DeliveredPr,
  type DeliveryRecord,
} from "@bayon/db/supervisor";
import { forgeCredential } from "../forge/credential.js";
import { FORGES } from "../forge/github.js";
import { deliverySecrets, scrubSecrets } from "../forge/scrub.js";
import { mirrorHead, pushBranch } from "./push.js";
import type { DeliveryCtx } from "./context.js";

// One ticket's delivery (spike §1.3, §1.8). Submodules first, then the parent: a
// superproject commit names its submodules' commits by sha, so a parent branch whose gitlinks point
// at commits no remote has is a pull request nobody can check out.
//
// Everything here is idempotent. A repo whose recorded delivery still names this branch's head — and
// which has the pull request its mode asks for — is skipped without a single git or HTTP call, and
// `pushBranch` answers `already` when the remote turns out to have the commit anyway. A re-run of a
// finished delivery therefore sends nothing and creates nothing.
//
// A failure stops the ticket: a parent is never pushed when one of its submodules could not be.

/** How long a `delivery` human request stays open before it expires: a week. */
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface Delivered {
  /** Repos this call actually pushed (an `already` is not one). */
  readonly pushed: number;
  /** Pull requests opened or reused. */
  readonly prs: number;
  /** True when nothing was left to do. */
  readonly noop: boolean;
  /** Why it stopped, when it did. */
  readonly failed: FrmError | null;
}

const NOTHING: Delivered = { pushed: 0, prs: 0, noop: true, failed: null };

/** What one repo needs, resolved: where to push and whether a forge can take a pull request. */
interface RepoTarget {
  readonly repo: DeliveryRepo;
  readonly remoteUrl: string;
  /**
   * `remoteUrl` with any credential taken out: what the delivery row records as `remote_url`, and
   * what the idempotency check compares against the row's (039).
   */
  readonly recordedUrl: string;
  readonly host: string | null;
  readonly forge: ForgeRemote | null;
  /** The forge's token from the host store, for its https API; null when the store has none. */
  readonly token: string | null;
  /**
   * The same token, offered to **git** only when the push URL is https (spike §1.5): an ssh or
   * path remote is pushed with no credential of ours at all.
   */
  readonly gitToken: string | null;
  /** True when this repo will get a pull request. */
  readonly wantsPr: boolean;
  /** Why it will not, when it will not; empty otherwise. */
  readonly why: string;
}

/**
 * `repo`'s target: its push target (039: `push_url ?? origin_url`, core `pushTargetOf`), the forge
 * its host names (if any), and the token for that forge (if the store has one). Everything a remote
 * decides — the push, the recorded host, the forge, the credential and the scrub list — is decided
 * by this one URL. It is read from the row only: git's own `remote` config is never consulted here.
 *
 * The forge and the token are resolved **before** the mode is consulted (code review,
 * HIGH 1). Only the pull-request decision depends on the mode; the git credential does not. A
 * project set to plain `push` against a private https repository needs that credential exactly as
 * much as one opening pull requests, and resolving it inside the `pull_request` branch meant every
 * such push failed, for ever, with nothing but a repeating operator request to show for it.
 *
 * A host with no forge kind, or a forge with no token, still pushes — and in `pull_request` mode
 * `why` is what the ticket's timeline will say about the request it did not open.
 */
async function targetOf(
  ctx: DeliveryCtx,
  repo: DeliveryRepo,
  pullRequests: boolean,
): Promise<Result<RepoTarget>> {
  const remoteUrl = pushTargetOf(repo);
  if (remoteUrl === null || remoteUrl.trim() === "") {
    return {
      ok: false,
      error: {
        class: "validation",
        message: `repo ${repo.repo_id} has no push_url or origin_url recorded; there is nowhere to deliver it`,
        retryable: false,
      },
    };
  }
  const host = remoteHost(remoteUrl);
  const { forge, token, gitToken } = await forgeCredential(
    ctx.secrets,
    remoteUrl,
    ctx.forgeRemoteOf,
  );
  const base = { repo, remoteUrl, recordedUrl: recordedUrlOf(remoteUrl), host };
  if (forge === null) {
    return {
      ok: true,
      value: {
        ...base,
        forge: null,
        token: null,
        gitToken: null,
        wantsPr: false,
        why: pullRequests
          ? `${host ?? remoteUrl} is not a forge Bayon can open a pull request on, so ${repo.repo_id}'s branch was pushed and nothing more`
          : "",
      },
    };
  }
  if (token === null) {
    return {
      ok: true,
      value: {
        ...base,
        forge,
        token: null,
        gitToken: null,
        wantsPr: false,
        why: pullRequests
          ? `no ${forgeTokenSecret(forge.kind)} in the host secret store, so ${repo.repo_id}'s branch was pushed and no pull request was opened`
          : "",
      },
    };
  }
  return {
    ok: true,
    value: {
      ...base,
      forge,
      token,
      // Offered to git whenever the push URL is https and its host is a forge we hold a token for,
      // whatever the mode (forgeCredential, the rule the mirror's origin reads share). An ssh or
      // path remote is pushed with no credential of ours at all.
      gitToken,
      wantsPr: pullRequests,
      why: "",
    },
  };
}

/**
 * Every secret a message about this repo's delivery could have picked up: the forge token, and any
 * credential in the recorded remote (`checkOriginUrl` allows `https://user:token@host/path`, and
 * git echoes the remote it could not reach). Used on every error before it is stored, shown or
 * logged (security review, MEDIUM 1).
 */
const secretsOf = (t: RepoTarget): string[] =>
  deliverySecrets(t.token ?? t.gitToken, t.remoteUrl);

/** `error` with every one of `secrets` taken out of its message. */
const redact = (error: FrmError, secrets: readonly string[]): FrmError => ({
  ...error,
  message: scrubSecrets(error.message, secrets),
});

/** The target a failed repo was being delivered to, as recorded; null when it had none. */
const failedTarget = (repo: DeliveryRepo): string | null => {
  const target = pushTargetOf(repo);
  return target === null || target.trim() === "" ? null : recordedUrlOf(target);
};

/** A target as a delivery row records it: never with a credential in it (§14). */
const recordedUrlOf = (url: string): string => stripPushUrlCredentials(url).url;

/**
 * Where the recorded delivery went. A row from before 039 has no `remote_url`: it went to the
 * repo's origin_url, which is what it is compared as.
 */
const deliveredTo = (t: RepoTarget): string | null => {
  const row = t.repo.delivered;
  if (row === null) return null;
  return row.remote_url ?? recordedUrlOf(t.repo.origin_url ?? "");
};

/**
 * Whether `repo`'s recorded delivery is still current: same target, same branch, same head, and
 * the pull request its mode asks for. This is the idempotency check — remove it and a finished
 * ticket is delivered again on every reconciler pass.
 *
 * The target is part of it (M8.1 review, HIGH 1): an operator who moves a repo's push_url means the
 * work to go there. Without it the new remote never got the branch — the old row said "done". The
 * whole URL, not the host: two repositories on one forge are two targets.
 */
const finished = (t: RepoTarget, head: string): boolean => {
  const row = t.repo.delivered;
  return (
    row !== null &&
    row.state !== "failed" &&
    deliveredTo(t) === t.recordedUrl &&
    row.branch === t.repo.branch &&
    row.head_sha === head &&
    (!t.wantsPr || row.pr_url !== null)
  );
};

/** What the record of one repo's outcome looks like before anything has happened to it. */
const recordOf = (
  t: RepoTarget,
  startedAt: number,
  rest: Pick<
    DeliveryRecord,
    "head_sha" | "state" | "pr_url" | "pr_number" | "error"
  >,
): DeliveryRecord => ({
  ticket_id: t.repo.delivered?.ticket_id ?? "",
  repo_id: t.repo.repo_id,
  branch: t.repo.branch,
  remote_host: t.host,
  remote_url: t.recordedUrl,
  started_at: startedAt,
  ...rest,
});

/** The whole of a ticket's delivery, as it is assembled repo by repo. */
interface Run {
  readonly records: DeliveryRecord[];
  readonly prs: DeliveredPr[];
  readonly bumps: DeliveredSubmodule[];
  readonly notes: string[];
  /**
   * The commit each repo is now at on its remote, by repo id. `finish` reads it so a failure
   * **after** a successful push records the head that is really there rather than the one the
   * pre-run snapshot held (code review, MEDIUM 3).
   */
  readonly heads: Map<string, string>;
  pushed: number;
  parentPr: string | null;
}

/**
 * Delivers `ticketId` if its project delivers and it has reached the moment. Writes nothing and
 * calls nothing when there is nothing to do.
 */
export async function deliverTicket(
  ctx: DeliveryCtx,
  ticketId: string,
  signal: AbortSignal,
): Promise<Result<Delivered>> {
  const planned = await deliveryPlan(ctx.db, ticketId);
  if (!planned.ok) return planned;
  const plan = planned.value;
  if (!plan.due || plan.repos.length === 0) return { ok: true, value: NOTHING };
  const key = plan.ticket_key;
  const pullRequests = opensPullRequests(plan.config.mode);
  const run: Run = {
    records: [],
    prs: [],
    bumps: [],
    notes: [],
    heads: new Map(),
    pushed: 0,
    parentPr: null,
  };
  for (const repo of plan.repos) {
    const target = await targetOf(ctx, repo, pullRequests);
    if (!target.ok) {
      // Even this one: the message names the repo, but a future one may name its remote.
      const secrets = deliverySecrets(null, pushTargetOf(repo) ?? "");
      return finish(ctx, plan, key, run, redact(target.error, secrets), repo);
    }
    const done = await deliverRepo(ctx, plan, key, run, target.value, signal);
    // EVERY failure leaves here scrubbed, so the row, the ticket's timeline, the operator's request
    // and the supervisor's log all get the redacted text and nothing else can reintroduce it.
    if (!done.ok) {
      return finish(
        ctx,
        plan,
        key,
        run,
        redact(done.error, secretsOf(target.value)),
        repo,
      );
    }
  }
  return finish(ctx, plan, key, run, null, null);
}

/** One repo: push if there is anything to push, then its pull request if its mode asks for one. */
async function deliverRepo(
  ctx: DeliveryCtx,
  plan: DeliveryPlan,
  key: string,
  run: Run,
  t: RepoTarget,
  signal: AbortSignal,
): Promise<Result<void>> {
  const startedAt = ctx.clock.now();
  const what = `delivering ${key} in ${t.repo.repo_id}`;
  const ask = {
    mirrorPath: t.repo.mirror_path,
    remoteUrl: t.remoteUrl,
    branch: t.repo.branch,
    token: t.gitToken,
    signal,
    what,
  };
  const local = await mirrorHead(ctx, ask);
  if (!local.ok) return local;
  // THE IDEMPOTENCY CHECK (spike §1.1). A repo already delivered at this commit, with the pull
  // request its mode asks for, is left exactly as it is — no `ls-remote`, no push, no forge call,
  // no row rewritten. Remove this and every reconciler pass re-delivers every finished ticket.
  if (finished(t, local.value)) {
    const row = t.repo.delivered;
    if (row !== null) {
      bump(run, t, local.value, row.pr_url);
      if (row.pr_url !== null) run.parentPr = parentUrl(t, run, row.pr_url);
    }
    return { ok: true, value: undefined };
  }
  const pushed = await pushBranch(ctx, ask);
  if (!pushed.ok) return pushed;
  const head = pushed.value.head;
  // The branch IS on the remote now: whatever happens next, a failure records this commit.
  run.heads.set(t.repo.repo_id, head);
  if (pushed.value.kind === "pushed") run.pushed += 1;
  if (t.why !== "") run.notes.push(t.why);
  if (!t.wantsPr || t.forge === null) {
    run.records.push(
      recordOf(t, startedAt, {
        head_sha: head,
        state: "pushed",
        pr_url: null,
        pr_number: null,
        error: null,
      }),
    );
    bump(run, t, head, null);
    return { ok: true, value: undefined };
  }
  const opened = await openPr(ctx, plan, key, run, t, head, signal);
  // `finish` writes the one row for this repo, `failed` at the commit `run.heads` now holds: the
  // push happened, the request did not, and a retry sees `already` rather than pushing again.
  if (!opened.ok) return opened;
  run.records.push(
    recordOf(t, startedAt, {
      head_sha: head,
      state: "pr_open",
      pr_url: opened.value.url,
      pr_number: opened.value.number,
      error: null,
    }),
  );
  run.prs.push({ repo_id: t.repo.repo_id, url: opened.value.url });
  bump(run, t, head, opened.value.url);
  run.parentPr = parentUrl(t, run, opened.value.url);
  return { ok: true, value: undefined };
}

/**
 * The ticket's canonical pull request: the parent's in a submodule or multi-repo project, the lone
 * repo's otherwise. A submodule's own request never takes the place of the parent's.
 */
const parentUrl = (t: RepoTarget, run: Run, url: string): string | null =>
  t.repo.submodule_path === null ? url : run.parentPr;

/** One submodule's line in the parent's body; a parent contributes none. */
function bump(
  run: Run,
  t: RepoTarget,
  head: string,
  prUrl: string | null,
): void {
  if (t.repo.submodule_path === null) return;
  run.bumps.push({
    path: t.repo.submodule_path,
    branch: t.repo.branch,
    sha: head,
    pr_url: prUrl,
  });
}

async function openPr(
  ctx: DeliveryCtx,
  plan: DeliveryPlan,
  key: string,
  run: Run,
  t: RepoTarget,
  head: string,
  signal: AbortSignal,
): ReturnType<typeof forgeOpen> {
  const facts = {
    key,
    title: plan.title,
    branch: t.repo.branch,
    base: t.repo.default_base_branch,
    acceptance: plan.acceptance_md,
    // Only the parent describes the gitlink bump; a submodule's own request has nothing to pin.
    submodules: t.repo.submodule_path === null ? run.bumps : [],
  };
  return forgeOpen(ctx, t, {
    head: t.repo.branch,
    base: t.repo.default_base_branch,
    title: pullRequestTitle(facts),
    body: pullRequestBody(facts),
    headSha: head,
    signal,
  });
}

async function forgeOpen(
  ctx: DeliveryCtx,
  t: RepoTarget,
  ask: {
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly headSha: string;
    readonly signal: AbortSignal;
  },
): Promise<Result<{ readonly url: string; readonly number: number }>> {
  const remote = t.forge;
  const token = t.token;
  const forge = remote === null ? undefined : FORGES.get(remote.kind);
  if (remote === null || forge === undefined || token === null) {
    return {
      ok: false,
      error: {
        class: "internal",
        message: `${t.repo.repo_id}: asked for a pull request with no forge`,
        retryable: false,
      },
    };
  }
  const opened = await forge.openPullRequest(
    {
      fetch: ctx.forgeFetch ?? ((url, init) => fetch(url, init)),
      token,
      host: remote.host,
      clock: ctx.clock,
      signal: ask.signal,
    },
    {
      remote,
      head: ask.head,
      base: ask.base,
      title: ask.title,
      body: ask.body,
    },
  );
  return opened.ok
    ? {
        ok: true,
        value: { url: opened.value.url, number: opened.value.number },
      }
    : opened;
}

/**
 * Writes what the run reached, in one transaction, and — when it stopped on something only the
 * operator can resolve — files the `delivery` human request for it (§14, spike §1.7).
 */
async function finish(
  ctx: DeliveryCtx,
  plan: DeliveryPlan,
  key: string,
  run: Run,
  failure: FrmError | null,
  at: DeliveryRepo | null,
): Promise<Result<Delivered>> {
  if (failure !== null && at !== null) {
    run.records.push({
      ticket_id: plan.ticket_id,
      repo_id: at.repo_id,
      branch: at.branch,
      head_sha: run.heads.get(at.repo_id) ?? at.delivered?.head_sha ?? null,
      remote_host: remoteHost(pushTargetOf(at) ?? ""),
      remote_url: failedTarget(at),
      state: "failed",
      pr_url: null,
      pr_number: null,
      error: failure.message,
      started_at: ctx.clock.now(),
    });
    run.notes.push(`${at.repo_id}: ${failure.message}`);
  }
  if (run.records.length === 0 && run.prs.length === 0) {
    return { ok: true, value: { ...NOTHING, failed: failure } };
  }
  const committed = await commitDelivery(ctx.db, {
    ticket_id: plan.ticket_id,
    records: run.records.map((r) => ({ ...r, ticket_id: plan.ticket_id })),
    prs: run.prs,
    pr_url: run.parentPr,
    note: run.notes.join(" · "),
  });
  if (!committed.ok) return committed;
  if (failure !== null && at !== null) {
    await askOperator(ctx, plan, key, run, at, failure);
  }
  return {
    ok: true,
    value: {
      pushed: run.pushed,
      prs: run.prs.length,
      noop: run.pushed === 0 && run.prs.length === 0 && failure === null,
      failed: failure,
    },
  };
}

/**
 * A `delivery` human request, for a failure the operator has to resolve: an authentication refusal,
 * a push the remote would not fast-forward, a forge that refused the request. A **retryable**
 * failure files none — the next pass tries again by itself, and a request per network blip is
 * noise. What makes that promise true is `gitFailure` (push.ts), which reads git's own words and
 * marks a transport error retryable; before it, every non-zero exit filed a request (code
 * review, MEDIUM 4).
 *
 * Keyed `delivery:<ticket>:<repo>@<head>`, so one condition asks once, and a new commit on the
 * branch asks again.
 */
async function askOperator(
  ctx: DeliveryCtx,
  plan: DeliveryPlan,
  key: string,
  run: Run,
  at: DeliveryRepo,
  failure: FrmError,
): Promise<void> {
  if (failure.retryable) return;
  const head = run.heads.get(at.repo_id) ?? at.delivered?.head_sha ?? null;
  const window =
    head === null ? at.repo_id : `${at.repo_id}@${head.slice(0, 12)}`;
  const filed = await insertSystemHumanRequest(ctx.db, {
    rule: "delivery",
    subject: plan.ticket_id,
    window,
    question: `${key} could not be delivered to ${at.repo_id}'s remote.`,
    context_md: excerpt(
      `Branch \`${at.branch}\` on \`${at.repo_id}\`.\n\n${failure.message}`,
      2_000,
    ),
    options: ["I fixed it — try again", "Stop delivering this project"],
    ticket_id: plan.ticket_id,
    expires_at: ctx.clock.now() + REQUEST_TTL_MS,
  });
  if (!filed.ok) {
    ctx.log.error(
      { ticketId: plan.ticket_id, error: filed.error },
      "delivery: cannot file the human request for a failed delivery",
    );
  }
}
