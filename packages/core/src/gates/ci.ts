import type { DeliveryConfigFields } from "../delivery/config.js";
import type { QaMode } from "./qa.js";
import { CI_CHECK_NAME_MAX } from "./schemas.js";

// CI checks as a project's QA source, pure: a `qa_harness` gate that runs nothing and
// waits for the checks the forge reports on the ticket's pull request. The supervisor reads the
// checks and writes the decision; every judgement about what they mean is here, table-testable.
//
// What Bayon knows about a project's CI is what it knows about its harness command, and no more:
// a check has a name and a state. No CI product, workflow file or naming convention is assumed. A
// project may name the checks it requires; one that names none requires every check reported.
//
// This file holds the configuration: the mode's refusal, the wait, check names, and the required
// entries. The verdict — each repo judged on its own checks — is `ci-verdict.ts`.

/**
 * `gates.subject_kind` of a `qa_harness` gate that waits on CI. Taken when the gate
 * opens (`planRound`'s `qaCi`), so a CI gate stays one if the project's mode changes while it
 * waits: nothing launches it, the gate sweep leaves it alone, and only the CI sweep decides it.
 */
export const CI_SUBJECT = "pull_request";

/**
 * The `deliveries.state`s whose pull request a CI gate reads: the CI sweep's `readyOf`
 * and core's `harnessOwed` share this one set, so the gate that opens and the sweep that judges it
 * can never disagree about which rows count.
 */
export const CI_PR_STATES: ReadonlySet<string> = new Set(["pr_open", "merged"]);

/** Whether a gate row is a CI gate: the mark it was opened with, never the project's mode now. */
export const isCiGate = (gate: { readonly subject_kind: string }): boolean =>
  gate.subject_kind === CI_SUBJECT;

/** How long a `ci` gate waits for its checks when the project sets nothing: an hour. */
export const QA_CI_TIMEOUT_DEFAULT_MS = 3_600_000;
/** Bounds on `qa_ci_timeout_ms`: under a minute no CI answers; past six hours is a stuck CI. */
export const QA_CI_TIMEOUT_MIN_MS = 60_000;
export const QA_CI_TIMEOUT_MAX_MS = 21_600_000;

/** The operator setting that bounds how long a gate waits for a first check to be reported. */
export const QA_CI_GRACE_KEY = "qa.ci_grace_ms";
/** Its seeded value (043): ten minutes with nothing reported is a CI that is not coming. */
export const QA_CI_GRACE_DEFAULT_MS = 600_000;

/** A `ci` gate's wait: the project's, held to the bounds, or the default. */
export const qaCiTimeoutOf = (ms: number | null | undefined): number =>
  ms === null || ms === undefined
    ? QA_CI_TIMEOUT_DEFAULT_MS
    : Math.min(QA_CI_TIMEOUT_MAX_MS, Math.max(QA_CI_TIMEOUT_MIN_MS, ms));

/**
 * The one sentence every door refuses `ci` mode with (043). The checks run on the pull request, and
 * a project that does not open one as review passes gives the gate nothing to wait on.
 */
export const QA_CI_NEEDS_PR =
  "CI checks as QA need delivery to open a pull request when review passes: set Delivery to “Open a pull request” at “Review passed” first.";

/** Why `mode` cannot be stored beside `delivery`, or null when it can. */
export const qaCiRefusal = (
  mode: QaMode,
  delivery: Pick<DeliveryConfigFields, "mode" | "when">,
): string | null =>
  mode === "ci" &&
  (delivery.mode !== "pull_request" || delivery.when !== "review_passed")
    ? QA_CI_NEEDS_PR
    : null;

/**
 * A check name as a forge reported it, fit to quote: control characters out, whitespace folded,
 * cut to `CI_CHECK_NAME_MAX`. A name becomes a finding, and a finding is compiled into the next fix
 * session's prompt, so it is never passed through raw. Null when nothing is left.
 */
export function ciCheckName(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ");
  const name = text.trim();
  if (name === "") return null;
  return name.length <= CI_CHECK_NAME_MAX
    ? name
    : `${name.slice(0, CI_CHECK_NAME_MAX - 1)}…`;
}

/**
 * The shape of a repo id at the front of a required entry: `<repo_id>:<name>`. Only a prefix of
 * this shape can name a repo, so a check name like `ci/lint: eslint` is never read as one.
 */
const QUALIFIED = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}:/;

/** An entry of the `<repo_id>:<name>` shape, split on its first colon; null for any other. */
function splitQualified(
  entry: string,
): { readonly repo: string; readonly name: string } | null {
  if (!QUALIFIED.test(entry)) return null;
  const at = entry.indexOf(":");
  return { repo: entry.slice(0, at), name: entry.slice(at + 1).trim() };
}

/**
 * One required check: a name, and the repo it is required in — or null, required in
 * every repo the ticket delivers.
 */
export interface CiRequirement {
  readonly repo_id: string | null;
  readonly name: string;
}

/**
 * The project's required entries as requirements. An entry is `name` — required in every delivered
 * repo — or `<repo_id>:<name>`, required in that repo only. It is split on its **first** colon, and
 * only when what comes before it is one of `repoIds`, the project's repos: a check's own name may
 * contain colons, and an entry whose prefix is no repo of the project is a plain name. So is one
 * whose name part is empty (the writers refuse both, `ciRequiredRefusal`; this reading is the
 * forgiving one, for a list stored before a repo changed).
 */
export function ciRequirements(
  entries: readonly string[],
  repoIds: readonly string[],
): CiRequirement[] {
  return entries.map((entry) => {
    const q = splitQualified(entry);
    return q !== null && repoIds.includes(q.repo) && q.name !== ""
      ? { repo_id: q.repo, name: q.name }
      : { repo_id: null, name: entry };
  });
}

/** The names required in `repoId`: its own qualified ones, and every unqualified one. */
export const requiredIn = (
  required: readonly CiRequirement[],
  repoId: string,
): readonly string[] => [
  ...new Set(
    required
      .filter((r) => r.repo_id === null || r.repo_id === repoId)
      .map((r) => r.name),
  ),
];

/**
 * Why a required entry cannot be stored for a project whose repos are `repoIds`, in one sentence,
 * or null. An entry of the `<repo_id>:<name>` shape must name one of them, and a check after it:
 * a typo'd repo would otherwise silently become a plain name no repo reports, and the gate would
 * wait for it until the deadline. A check whose own name has a colon is required by putting a repo
 * first — `<repo_id>:<name:with:colons>` splits on the first colon only.
 */
export function ciRequiredRefusal(
  entries: readonly string[],
  repoIds: readonly string[],
): string | null {
  for (const entry of entries) {
    const q = splitQualified(entry);
    if (q === null) continue;
    const { repo, name } = q;
    if (!repoIds.includes(repo)) {
      const example = `${repoIds[0] ?? "<repo>"}:${entry}`;
      return `The required check “${entry}” reads as repo “${repo}”, which is not one of this project's repos (${repoIds.join(", ")}): to require a check whose name has a colon, put its repo first, as “${example}”.`;
    }
    if (name === "") {
      return `The required check “${entry}” names repo “${repo}” but no check: write it as “${repo}:<check name>”.`;
    }
  }
  return null;
}

/**
 * Whether an entry has the `<repo_id>:<name>` shape with an empty name: what the wire schema can
 * refuse without knowing the project's repos (proto `QaCiCheckName`).
 */
export const ciEntryNamesNoCheck = (entry: string): boolean =>
  splitQualified(entry)?.name === "";
