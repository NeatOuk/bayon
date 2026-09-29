import {
  ciCheckName,
  err,
  ok,
  type CiCheckState,
  type ForgeRemote,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import type {
  Forge,
  ForgeCheck,
  OpenedPullRequest,
  PullRequestAsk,
  PullRequestState,
} from "./forge.js";
import {
  forgeCall,
  forgeError,
  type ForgeAnswer,
  type ForgeHttp,
} from "./http.js";

// The one forge kind with an implementation (spike §1.8). It knows five REST calls and
// nothing else: list the open pull requests for a head branch, create one, read one by number
// (what the pull-request sweep polls), and list a commit's check runs and its combined
// status (what the CI sweep reads). No org, no
// repository and no deployment is named here — `ask.remote` carries owner and repo, parsed from
// whatever URL the operator recorded when the project was created.
//
// Reuse comes first, always. A retry after a half-failed run must not open a second pull request,
// and the forge is the only thing that can say whether one already exists.

const PullRequest = z.object({
  number: z.int().positive(),
  html_url: z.string().min(1),
});
type PullRequest = z.infer<typeof PullRequest>;

const PullRequestList = z.array(PullRequest);

/**
 * Whether `url` is a page on the remote's own forge: `https://<host>/…`, where host is the one the
 * push target named (a `www.` alias of it too). The url is stored on the ticket, linked from the
 * GUI, quoted in human requests and posted to Jira, so an answer naming any other place is refused
 * as malformed rather than recorded (LOW 3).
 */
export function onForge(url: string, remote: ForgeRemote): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const own = remote.host.replace(/^www\./, "");
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    (host === own || host === `www.${own}`)
  );
}

/**
 * A forge login: GitHub's rule (alphanumerics and single inner hyphens, at most 39), plus the
 * `[bot]` suffix an app's login carries. What `merged_by` may store and a timeline or Jira comment
 * may quote (MEDIUM 2).
 */
const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}(?:\[bot\])?$/i;

/** What `merged_by` records for a login that is not one: the merge still counts. */
export const UNKNOWN_LOGIN = "unknown";

/** A login as recorded: itself when it has a login's shape, else UNKNOWN_LOGIN; null for none. */
export const loginOf = (login: string | null): string | null =>
  login === null ? null : LOGIN.test(login) ? login : UNKNOWN_LOGIN;

/** A forge error body, read loosely: whatever does not parse says nothing. */
const ErrorBody = z
  .object({
    message: z.string().catch(""),
    errors: z
      .array(z.object({ message: z.string().catch("") }).catch({ message: "" }))
      .catch([]),
  })
  .catch({ message: "", errors: [] });

/** What the forge said, for a message: its own words, or the status alone. */
function said(json: unknown): string {
  const body = ErrorBody.parse(json);
  const parts = [body.message, ...body.errors.map((e) => e.message)].filter(
    (m) => m !== "",
  );
  return parts.join("; ");
}

const pullsOf = (remote: ForgeRemote): string =>
  `${remote.apiBase}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pulls`;

const api = (ask: PullRequestAsk): string => pullsOf(ask.remote);

/**
 * One pull request as the forge answers `GET …/pulls/{n}`. Only what the sweep reads;
 * `merged_by` is the login alone — the rest of that user object is never kept.
 */
const PullRequestDetail = z.object({
  number: z.int().positive(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  merged_at: z.iso.datetime({ offset: true }).nullable(),
  // Read loosely here and judged by loginOf: an odd login must not stop a merge being recorded.
  merged_by: z.object({ login: z.string() }).nullable(),
  html_url: z.string().min(1),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/) }),
});

/** How a non-2xx answer becomes the error the delivery job reports. */
function refused(
  http: ForgeHttp,
  what: string,
  a: ForgeAnswer,
): ReturnType<typeof forgeError> {
  const detail = said(a.json);
  const tail = detail === "" ? "" : `: ${detail}`;
  if (a.status === 401 || a.status === 403) {
    // Never the token, never the header: only which secret to check (§14, Invariant 11).
    return forgeError(
      http,
      "validation",
      `${http.host} refused ${what} (HTTP ${a.status})${tail}. Check the forge token in the host secret store; it must be allowed to write this repository.`,
      false,
      a.status,
    );
  }
  if (a.status === 404) {
    return forgeError(
      http,
      "validation",
      `${http.host} does not show this repository to the forge token (HTTP 404)${tail}`,
      false,
      a.status,
    );
  }
  if (a.status >= 500) {
    return forgeError(
      http,
      "runner_error",
      `${http.host} answered ${what} with HTTP ${a.status}; the next pass tries again`,
      true,
      a.status,
    );
  }
  return forgeError(
    http,
    "validation",
    `${http.host} refused ${what} (HTTP ${a.status})${tail}`,
    false,
    a.status,
  );
}

const found = (pr: PullRequest, reused: boolean): OpenedPullRequest => ({
  url: pr.html_url,
  number: pr.number,
  reused,
});

/** The open pull request for this head and base, or null. */
async function existing(
  http: ForgeHttp,
  ask: PullRequestAsk,
): Promise<Result<PullRequest | null>> {
  const url = new URL(api(ask));
  // `<owner>:<branch>` is how the forge spells a head; the owner is the repo's own, never a fork's.
  url.searchParams.set("head", `${ask.remote.owner}:${ask.head}`);
  url.searchParams.set("base", ask.base);
  url.searchParams.set("state", "open");
  const what = `the open pull requests for ${ask.head}`;
  const answer = await forgeCall(http, {
    method: "GET",
    url: url.toString(),
    what,
  });
  if (!answer.ok) return answer;
  if (answer.value.status !== 200) {
    return err(refused(http, what, answer.value));
  }
  const parsed = PullRequestList.safeParse(answer.value.json);
  if (
    !parsed.success ||
    !parsed.data.every((pr) => onForge(pr.html_url, ask.remote))
  ) {
    return err(
      forgeError(
        http,
        "runner_error",
        `${http.host} answered ${what} with a body this cannot read`,
        false,
      ),
    );
  }
  return ok(parsed.data[0] ?? null);
}

async function create(
  http: ForgeHttp,
  ask: PullRequestAsk,
): Promise<Result<OpenedPullRequest>> {
  const what = `a pull request for ${ask.head}`;
  const answer = await forgeCall(http, {
    method: "POST",
    url: api(ask),
    what,
    body: {
      title: ask.title,
      head: ask.head,
      base: ask.base,
      body: ask.body,
    },
  });
  if (!answer.ok) return answer;
  const { status, json } = answer.value;
  if (status === 422) {
    // The forge says one already exists, or the branch cannot be a head. Ask again rather than
    // failing: between the list above and this call, another pass — or a person — may have opened
    // it, and the forge is the authority.
    const again = await existing(http, ask);
    if (!again.ok) return again;
    return again.value === null
      ? err(refused(http, what, answer.value))
      : ok(found(again.value, true));
  }
  if (status !== 201) return err(refused(http, what, answer.value));
  const parsed = PullRequest.safeParse(json);
  return parsed.success && onForge(parsed.data.html_url, ask.remote)
    ? ok(found(parsed.data, false))
    : err(
        forgeError(
          http,
          "runner_error",
          `${http.host} answered ${what} with a body this cannot read`,
          false,
        ),
      );
}

/** Pull request `number` on `remote`, as it stands now. */
async function detail(
  http: ForgeHttp,
  remote: ForgeRemote,
  number: number,
): Promise<Result<PullRequestState>> {
  const what = `pull request #${number}`;
  if (!Number.isSafeInteger(number) || number <= 0) {
    return err(
      forgeError(
        http,
        "validation",
        `${what} is not a pull request number`,
        false,
      ),
    );
  }
  const answer = await forgeCall(http, {
    method: "GET",
    url: `${pullsOf(remote)}/${number}`,
    what,
  });
  if (!answer.ok) return answer;
  if (answer.value.status !== 200) {
    return err(refused(http, what, answer.value));
  }
  const parsed = PullRequestDetail.safeParse(answer.value.json);
  if (
    !parsed.success ||
    parsed.data.number !== number ||
    !onForge(parsed.data.html_url, remote)
  ) {
    return err(
      forgeError(
        http,
        "runner_error",
        `${http.host} answered ${what} with a body this cannot read`,
        false,
      ),
    );
  }
  const pr = parsed.data;
  return ok({
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at === null ? null : Date.parse(pr.merged_at),
    merged_by: loginOf(pr.merged_by?.login ?? null),
    head_sha: pr.head.sha,
  });
}

// ─── Checks on a commit ──────────────────────────────────────────────────────────────

/** A page of checks, the most the forge serves at once. */
export const FORGE_CHECKS_PER_PAGE = 100;
/**
 * The most pages read per list. Past it the list is refused, not cut: a failure on the page after
 * the last one read must not let the gate pass.
 */
export const FORGE_CHECK_PAGES_MAX = 10;

/** A full commit id: what a check list is asked for, checked before any URL is built. */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const CheckRun = z.object({
  id: z.int().nonnegative(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  /** When the run started; absent or null for one still queued. What `latestRuns` orders by. */
  started_at: z.iso.datetime({ offset: true }).nullable().optional(),
  html_url: z.string().nullable().optional(),
  details_url: z.string().nullable().optional(),
});
type CheckRun = z.infer<typeof CheckRun>;
const CheckRunsPage = z.object({
  total_count: z.int().nonnegative(),
  check_runs: z.array(CheckRun),
});
const CommitStatus = z.object({
  context: z.string(),
  state: z.string(),
  target_url: z.string().nullable().optional(),
});
const StatusPage = z.object({
  total_count: z.int().nonnegative(),
  statuses: z.array(CommitStatus),
});

/** The conclusions a finished check run failed with. */
const RUN_FAILED: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/**
 * A check run's state. Anything not `completed` is still running; a completed one is success,
 * neutral, skipped or a failure; `stale` and an absent or unknown conclusion have not settled, and
 * are waited on (the deadline decides them) rather than read as the code's failure.
 */
export function checkRunState(
  status: string,
  conclusion: string | null,
): CiCheckState {
  if (status !== "completed") return "pending";
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return conclusion;
    default:
      return conclusion !== null && RUN_FAILED.has(conclusion)
        ? "failure"
        : "pending";
  }
}

/** A commit status's state: `error` fails as `failure` does; anything unknown is still pending. */
export const statusState = (state: string): CiCheckState =>
  state === "success"
    ? "success"
    : state === "failure" || state === "error"
      ? "failure"
      : "pending";

/** A run's start as epoch-millis; one not started yet is the oldest there is. */
const startedMs = (r: CheckRun): number =>
  r.started_at === null || r.started_at === undefined
    ? Number.NEGATIVE_INFINITY
    : Date.parse(r.started_at);

/** Whether run `a` is newer than run `b`: the later start, then the higher id. */
const newer = (a: CheckRun, b: CheckRun): boolean => {
  const ta = startedMs(a);
  const tb = startedMs(b);
  return ta !== tb ? ta > tb : a.id > b.id;
};

/**
 * The newest run of each check name: a "re-run failed jobs" on the same commit
 * adds a new run under the same name while the failed one is still listed, and judging both would
 * send an already-green rerun to rework and count the check twice. `filter=latest` asks the forge
 * for this already; this holds it whatever the forge answers. Newest is the latest `started_at` —
 * one not started yet counts as the oldest — and then the highest id. Combined statuses are one per
 * context already and are never folded into the runs: a run and a status sharing a name both count.
 */
export function latestRuns(runs: readonly CheckRun[]): CheckRun[] {
  // A map local to this call, filled in one pass: up to ten pages of runs, never copied per run.
  const byName = new Map<string, CheckRun>();
  for (const r of runs) {
    const held = byName.get(r.name);
    if (held === undefined || newer(r, held)) byName.set(r.name, r);
  }
  return [...byName.values()];
}

/** What a check is called in a finding when the forge gave it no usable name. */
export const UNNAMED_CHECK = "(unnamed check)";

/** One normalized check: its name cleaned, its link kept only on the remote's own forge. */
const checkOf = (
  remote: ForgeRemote,
  name: string,
  state: CiCheckState,
  url: string | null | undefined,
): ForgeCheck => ({
  name: ciCheckName(name) ?? UNNAMED_CHECK,
  state,
  url: url !== null && url !== undefined && onForge(url, remote) ? url : null,
});

interface Page<T> {
  readonly total: number;
  readonly items: readonly T[];
}

/**
 * Every item of a paged list at `base`, `FORGE_CHECKS_PER_PAGE` a page, until the answer's own
 * total is reached or a page comes back short. More than `FORGE_CHECK_PAGES_MAX` pages is refused.
 * Every request is `forgeCall`'s, so every guard of the floor holds on every page.
 */
async function everyPage<T>(
  http: ForgeHttp,
  base: string,
  what: string,
  read: (json: unknown) => Page<T> | null,
): Promise<Result<T[]>> {
  const items: T[] = [];
  for (let page = 1; page <= FORGE_CHECK_PAGES_MAX; page += 1) {
    const url = new URL(base);
    url.searchParams.set("per_page", String(FORGE_CHECKS_PER_PAGE));
    url.searchParams.set("page", String(page));
    const answer = await forgeCall(http, {
      method: "GET",
      url: url.toString(),
      what,
    });
    if (!answer.ok) return answer;
    if (answer.value.status !== 200) {
      return err(refused(http, what, answer.value));
    }
    const got = read(answer.value.json);
    if (got === null) {
      return err(
        forgeError(
          http,
          "runner_error",
          `${http.host} answered ${what} with a body this cannot read`,
          false,
        ),
      );
    }
    items.push(...got.items);
    if (items.length >= got.total || got.items.length < FORGE_CHECKS_PER_PAGE) {
      return ok(items);
    }
  }
  return err(
    forgeError(
      http,
      "validation",
      `${http.host} lists more than ${String(FORGE_CHECK_PAGES_MAX * FORGE_CHECKS_PER_PAGE)} entries for ${what}; a partial list could hide a failure, so none of it is read`,
      false,
    ),
  );
}

/** The check runs and the combined status of commit `sha`, merged into one list. */
async function checks(
  http: ForgeHttp,
  remote: ForgeRemote,
  sha: string,
): Promise<Result<readonly ForgeCheck[]>> {
  if (!COMMIT.test(sha)) {
    return err(
      forgeError(
        http,
        "validation",
        `${JSON.stringify(sha.slice(0, 80))} is not a full commit id`,
        false,
      ),
    );
  }
  const commit = `${remote.apiBase}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/commits/${sha}`;
  const short = sha.slice(0, 12);
  const runs = await everyPage(
    http,
    // The latest run of each check, as the forge's own default says, asked for explicitly.
    `${commit}/check-runs?filter=latest`,
    `the check runs of ${short}`,
    (json) => {
      const page = CheckRunsPage.safeParse(json);
      return page.success
        ? { total: page.data.total_count, items: page.data.check_runs }
        : null;
    },
  );
  if (!runs.ok) return runs;
  const statuses = await everyPage(
    http,
    `${commit}/status`,
    `the statuses of ${short}`,
    (json) => {
      const page = StatusPage.safeParse(json);
      return page.success
        ? { total: page.data.total_count, items: page.data.statuses }
        : null;
    },
  );
  if (!statuses.ok) return statuses;
  return ok([
    ...latestRuns(runs.value).map((r) =>
      checkOf(
        remote,
        r.name,
        checkRunState(r.status, r.conclusion),
        r.html_url ?? r.details_url,
      ),
    ),
    ...statuses.value.map((s) =>
      checkOf(remote, s.context, statusState(s.state), s.target_url),
    ),
  ]);
}

export const githubForge: Forge = {
  kind: "github",
  async openPullRequest(http, ask) {
    const already = await existing(http, ask);
    if (!already.ok) return already;
    return already.value === null
      ? create(http, ask)
      : ok(found(already.value, true));
  },
  getPullRequest: detail,
  listChecks: checks,
};

/** Every kind with an implementation, by kind. A host with no entry falls back to `push`. */
export const FORGES: ReadonlyMap<string, Forge> = new Map([
  [githubForge.kind, githubForge],
]);
