import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CI_PR_STATES,
  QA_CI_GRACE_KEY,
  ciEvidence,
  ciFindings,
  ciRequirements,
  ciVerdict,
  forgeRemote,
  forgeTokenSecret,
  gateFailure,
  pushTargetOf,
  qaCiTimeoutOf,
  remoteHost,
  repoProgress,
  type CiCheck,
  type CiRepoFacts,
  type CiRequirement,
  type CiVerdict,
  type GateFailReason,
  type ReviewFinding,
  type Result,
} from "@bayon/core";
import {
  ciGatePlan,
  listCiGates,
  type CiGateCandidate,
  type CiGateCursor,
  type CiGatePlan,
  type DeliveryRepo,
} from "@bayon/db";
import {
  decideGate,
  recordCiProgress,
  type CiRead,
} from "@bayon/db/supervisor";
import { FORGES } from "../forge/github.js";
import { deliverySecrets, scrubSecrets } from "../forge/scrub.js";
import { gateArtifactsDir } from "../paths.js";
import type { DeliveryCtx } from "./context.js";
import { mirrorHead } from "./push.js";

// The CI sweep (spike §1.5): the step that decides `qa_harness` gates a project's CI
// answers. Run right after the pull-request sweep at the end of every reconciler pass, in that
// sweep's shape — a page, a wall-clock budget checked between gates, an in-memory keyset cursor —
// because it too calls out to a network.
//
// Per running CI gate: find the pull request at the reviewed commit in each of the ticket's repos,
// read that commit's checks from the forge, and let core's `ciVerdict` say what they mean. A pass
// or a failed check is decided through `decideGate` with §10.3 evidence (the check list is its
// artifact) and blocking findings, so `pass_harness` or `fail_harness` follows in that transaction.
// No pull request yet, or checks still running, decides nothing: the only write is the progress the
// next step shows, and only when it changed. Nothing reported past the grace, the deadline, or a
// forge that refuses to answer is `reviewer_error` / `timeout` — infra, never a fix round.

/** The most gates one pass looks at; the next pass carries on after the last of them. */
export const CI_SWEEP_MAX = 25;

/** The longest one pass spends reading checks, checked between gates. */
export const CI_SWEEP_BUDGET_MS = 30_000;

/** The artifact that holds every check a decision read (Invariant 9: the whole list on disk). */
export const CI_CHECKS_ARTIFACT = "ci-checks.json";

/** Where each lifecycle's sweep left off. In memory: a restart starts from the top, harmlessly. */
const cursors = new WeakMap<DeliveryCtx, CiGateCursor>();

export interface CiSwept {
  /** Gates this pass actually looked at; fewer than the page when the budget ran out. */
  readonly looked: number;
  /** Gates decided this pass: passed, failed on a check, or failed as infra. */
  readonly decided: number;
  /** Gates whose read or write failed this pass (logged; the next pass tries again). */
  readonly failed: number;
  readonly budgetSpent: boolean;
}

export interface CiSweepOptions {
  readonly signal?: AbortSignal;
  /** Replaces CI_SWEEP_BUDGET_MS for this pass (tests). */
  readonly budgetMs?: number;
}

/** One repo's pull request at the commit the gate judges. */
interface Ready {
  readonly repo: DeliveryRepo;
  readonly sha: string;
  readonly prUrl: string;
  /** Where it was delivered: the row's own target, else the repo's (039). */
  readonly target: string;
}

/** What one gate's read came to: a verdict, or a wait with nothing to decide yet. */
type Read =
  | { readonly kind: "awaiting_pr" }
  /** Every repo's pull request at its head, and **its own** checks: each repo is judged alone. */
  | { readonly kind: "checks"; readonly repos: readonly CiRepoFacts[] }
  /** A forge that could not answer this pass but may the next: nothing is written. */
  | { readonly kind: "retry"; readonly message: string }
  /** A forge that cannot answer at all: the gate is decided `reviewer_error` with this. */
  | { readonly kind: "refused"; readonly message: string };

/**
 * The repo's pull request at the commit its branch is at **now**, or null. The delivery row must
 * have a request, be on the branch the ticket's work is on, and carry the mirror's current head of
 * it: a new commit not yet pushed after rework reads as "no pull request yet", so a new round is
 * never judged on the last round's red checks.
 */
async function readyOf(
  ctx: DeliveryCtx,
  repo: DeliveryRepo,
  signal: AbortSignal,
): Promise<Ready | null> {
  const row = repo.delivered;
  if (
    row === null ||
    !CI_PR_STATES.has(row.state) ||
    row.pr_url === null ||
    row.head_sha === null ||
    row.branch !== repo.branch
  ) {
    return null;
  }
  const target = row.remote_url ?? pushTargetOf(repo) ?? "";
  const head = await mirrorHead(ctx, {
    mirrorPath: repo.mirror_path,
    remoteUrl: target,
    branch: repo.branch,
    token: null,
    signal,
    what: `reading ${repo.repo_id}'s head for its CI`,
  });
  if (!head.ok || head.value !== row.head_sha) return null;
  return { repo, sha: head.value, prUrl: row.pr_url, target };
}

/** One ready repo's checks from its forge, each tagged with the repo. */
async function checksOf(
  ctx: DeliveryCtx,
  r: Ready,
  signal: AbortSignal,
): Promise<Result<readonly CiCheck[]>> {
  const remote = (ctx.forgeRemoteOf ?? forgeRemote)(r.target);
  const forge = remote === null ? undefined : FORGES.get(remote.kind);
  if (remote === null || forge === undefined) {
    const host = remoteHost(r.target) ?? r.repo.repo_id;
    return {
      ok: false,
      error: {
        class: "validation",
        message: `${host} is not a forge Bayon can read CI checks on`,
        retryable: false,
      },
    };
  }
  const secret = forgeTokenSecret(remote.kind);
  const token = await ctx.secrets.get(secret);
  if (!token.ok) {
    return {
      ok: false,
      error: {
        class: "validation",
        message: `no ${secret} in the host secret store, so ${r.repo.repo_id}'s CI checks cannot be read`,
        retryable: false,
      },
    };
  }
  const got = await forge.listChecks(
    {
      fetch: ctx.forgeFetch ?? ((url, init) => fetch(url, init)),
      token: token.value,
      host: remote.host,
      clock: ctx.clock,
      signal,
    },
    remote,
    r.sha,
  );
  if (!got.ok) {
    // The forge layer scrubs its token already; this takes out the remote's own userinfo too.
    return {
      ok: false,
      error: {
        ...got.error,
        message: scrubSecrets(
          got.error.message,
          deliverySecrets(token.value, r.target),
        ),
      },
    };
  }
  return { ok: true, value: got.value };
}

/**
 * Everything one gate needs read: which pull requests, and, when every repo has one at its head,
 * each repo's own checks. `repos` is the plan's — the ticket's branches, whatever its status.
 */
async function readGate(
  ctx: DeliveryCtx,
  repos: readonly DeliveryRepo[],
  signal: AbortSignal,
): Promise<Read> {
  if (repos.length === 0) return { kind: "awaiting_pr" };
  const ready: Ready[] = [];
  for (const repo of repos) {
    const r = await readyOf(ctx, repo, signal);
    if (r === null) return { kind: "awaiting_pr" };
    ready.push(r);
  }
  const read: CiRepoFacts[] = [];
  for (const r of ready) {
    const got = await checksOf(ctx, r, signal);
    if (!got.ok) {
      return got.error.retryable
        ? { kind: "retry", message: got.error.message }
        : { kind: "refused", message: got.error.message };
    }
    read.push({
      repo_id: r.repo.repo_id,
      sha: r.sha,
      pr_url: r.prUrl,
      checks: got.value,
    });
  }
  return { kind: "checks", repos: read };
}

/** Each repo's own progress, for the next step's "n of m" across them (core `repoProgress`). */
const readsOf = (
  repos: readonly CiRepoFacts[],
  required: readonly CiRequirement[],
): CiRead[] =>
  repos.map((r) => ({
    repo_id: r.repo_id,
    sha: r.sha,
    ...repoProgress(r, required),
  }));

/** The whole check list, beside the gate's other artifacts; its path is the evidence's artifact. */
async function writeArtifact(
  ctx: DeliveryCtx,
  plan: CiGatePlan,
  repos: readonly CiRepoFacts[],
): Promise<string> {
  const dir = gateArtifactsDir(ctx.frmHome, plan.gate.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, CI_CHECKS_ARTIFACT);
  // Repo by repo, as the verdict judged them: every check of each, nothing capped.
  const body = {
    gate_id: plan.gate.id,
    read_at: ctx.clock.now(),
    required: plan.required,
    repos: repos.map((r) => ({
      repo_id: r.repo_id,
      sha: r.sha,
      pr_url: r.pr_url,
      checks: r.checks,
    })),
  };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

/** decideGate, logged; a gate that stopped running first (superseded, waived) is not an error. */
async function decide(
  ctx: DeliveryCtx,
  gateId: string,
  evidence: unknown,
  findings: readonly ReviewFinding[],
): Promise<Result<boolean>> {
  const d = await decideGate(ctx.db, {
    gate_id: gateId,
    session_id: null,
    evidence,
    findings,
  });
  if (!d.ok) {
    if (d.error.class !== "conflict") return d;
    ctx.log.info(
      { gateId, cause: d.error.cause },
      "CI sweep: the gate stopped running first (superseded or waived)",
    );
    return { ok: true, value: false };
  }
  const step = d.value.advance;
  ctx.log.info(
    {
      gateId,
      state: d.value.gate.state,
      moved: step.advanced ? step.to : null,
    },
    "CI sweep: a CI gate decided",
  );
  return { ok: true, value: true };
}

const infra = (
  reason: Extract<GateFailReason, "timeout" | "reviewer_error">,
  detail: string,
) => gateFailure({ reason, detail });

/** A pass or a failed check: the artifact, §10.3 evidence, one finding per failed check. */
async function decideOnChecks(
  ctx: DeliveryCtx,
  plan: CiGatePlan,
  repos: readonly CiRepoFacts[],
  v: Extract<CiVerdict, { kind: "pass" | "fail" }>,
): Promise<Result<boolean>> {
  const artifact = await writeArtifact(ctx, plan, repos);
  return decide(
    ctx,
    plan.gate.id,
    ciEvidence({
      required: plan.required,
      repos,
      failed: v.kind === "fail",
      startedAt: plan.gate.started_at ?? ctx.clock.now(),
      now: ctx.clock.now(),
      artifactPath: artifact,
    }),
    v.kind === "fail" ? ciFindings(v.failed) : [],
  );
}

/** One gate: read, judge, and decide or record progress. True when it was decided. */
async function judgeGate(
  ctx: DeliveryCtx,
  gate: CiGateCandidate,
  signal: AbortSignal,
): Promise<Result<boolean>> {
  const planned = await ciGatePlan(ctx.db, gate.id);
  if (!planned.ok) return planned;
  const plan = planned.value;
  // Any status (review MEDIUM 2): a blocked or paused ticket's CI still runs and its deadline still
  // comes. The decision moves the ticket only from qa_harness — `machineStep` names no step for any
  // other status — and the machine sweep takes it once the ticket is back there.
  if (plan.gate.state !== "running") return { ok: true, value: false };
  const r = await readGate(ctx, plan.repos, signal);
  if (r.kind === "retry") {
    ctx.log.warn(
      { gateId: gate.id, error: r.message },
      "CI sweep: the forge could not answer; the next pass asks again",
    );
    return { ok: true, value: false };
  }
  if (r.kind === "refused") {
    return decide(ctx, gate.id, infra("reviewer_error", r.message), []);
  }
  const required = ciRequirements(plan.required, plan.repo_ids);
  const v = ciVerdict({
    awaitingPr: r.kind === "awaiting_pr",
    repos: r.kind === "checks" ? r.repos : [],
    required,
    startedAt: plan.gate.started_at ?? ctx.clock.now(),
    now: ctx.clock.now(),
    graceMs: ctx.settings[QA_CI_GRACE_KEY],
    timeoutMs: qaCiTimeoutOf(plan.timeout_ms),
  });
  if (v.kind === "infra") {
    return decide(ctx, gate.id, infra(v.reason, v.detail), []);
  }
  // Every other answer came from checks that were read; with no pull request there is only a wait.
  if (r.kind !== "checks") return { ok: true, value: false };
  if (v.kind === "pass" || v.kind === "fail") {
    return decideOnChecks(ctx, plan, r.repos, v);
  }
  const recorded = await recordCiProgress(ctx.db, {
    gate_id: gate.id,
    ticket_id: plan.gate.ticket_id,
    reads: readsOf(r.repos, required),
  });
  return recorded.ok ? { ok: true, value: false } : recorded;
}

/** Where the next pass starts, given what this one got through (the delivery sweep's rule). */
function remember(
  ctx: DeliveryCtx,
  page: readonly CiGateCandidate[],
  done: CiGateCandidate | null,
  budgetSpent: boolean,
): void {
  if (budgetSpent) {
    if (done !== null) {
      cursors.set(ctx, { started_at: done.started_at, id: done.id });
    }
    return;
  }
  const last = page.at(-1);
  if (last === undefined || page.length < CI_SWEEP_MAX) {
    cursors.delete(ctx);
    return;
  }
  cursors.set(ctx, { started_at: last.started_at, id: last.id });
}

export async function sweepCiGates(
  ctx: DeliveryCtx,
  o: CiSweepOptions = {},
): Promise<CiSwept> {
  const none: CiSwept = {
    looked: 0,
    decided: 0,
    failed: 0,
    budgetSpent: false,
  };
  const page = await listCiGates(ctx.db, {
    limit: CI_SWEEP_MAX,
    after: cursors.get(ctx) ?? null,
  });
  if (!page.ok) {
    ctx.log.error(
      { error: page.error },
      "CI sweep: cannot list the gates that wait on CI",
    );
    return none;
  }
  const stop = o.signal ?? new AbortController().signal;
  const budgetMs = o.budgetMs ?? CI_SWEEP_BUDGET_MS;
  const startedAt = ctx.clock.now();
  let totals = none;
  let done: CiGateCandidate | null = null;
  for (const gate of page.value) {
    if (ctx.clock.now() - startedAt >= budgetMs) {
      totals = { ...totals, budgetSpent: true };
      ctx.log.info(
        { looked: totals.looked, of: page.value.length, budgetMs },
        "CI sweep: out of budget for this pass; the next one carries on",
      );
      break;
    }
    const out = await judgeGate(ctx, gate, stop).catch(
      (e: unknown): Result<boolean> => ({
        ok: false,
        error: {
          class: "internal",
          message: e instanceof Error ? e.message : String(e),
          retryable: true,
        },
      }),
    );
    done = gate;
    totals = { ...totals, looked: totals.looked + 1 };
    if (!out.ok) {
      totals = { ...totals, failed: totals.failed + 1 };
      ctx.log.error(
        { gateId: gate.id, error: out.error },
        "CI sweep: a CI gate could not be read or decided",
      );
      continue;
    }
    if (out.value) totals = { ...totals, decided: totals.decided + 1 };
  }
  remember(ctx, page.value, done, totals.budgetSpent);
  return totals;
}
