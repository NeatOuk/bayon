// A project's own settings:
// `PATCH /projects/:id` writes `workspaces.staff_approval`, the Jira source (`jira_url`,
// `jira_email`, `jira_jql`), the QA harness (`qa_mode`, `qa_cmd`, `qa_timeout_ms`,
// `qa_secrets_json`, `qa_reports_json`, `qa_junit`, and 043's `qa_ci_checks_json` and
// `qa_ci_timeout_ms` —), the documentation source (`docs_kind`,
// `docs_url`, `docs_email`, `docs_spaces_json`), delivery (`delivery_mode`, `delivery_when`,
// `close_on_merge` — 040, an earlier change — and 047's `delivery_since`), its tier per step
// (`plan_tier`, `build_tier`, `review_tier` — 048) and its repos' push targets
// (`repos.push_url`, 039; push-targets.ts) through @bayon/db/api, shaped as the project's pause (project-pause.ts). One transaction: the
// project is read, and a real change writes its columns with one `project.set` audit row naming only
// what changed; values it already has write neither. Staffing reads the switch (staff-proposal.ts),
// the API's Jira sync the source, the laws the QA mode (`qa_configured`), and the supervisor's
// delivery sweep the delivery pair — where the audited change IS the §14 approval for the network
// writes the job then makes (the design §1.7). The context compression switch (049,
//) is read at spawn: a session pins what it was spawned with, so a change reaches only
// the sessions spawned after it.
//
// The QA command is audited but never treated as a secret: `qa_secrets` holds secret NAMES, and a
// value never comes near this table (§14, Invariant 11).
//
// One transaction covers the QA mode moving to `pending` **and** the ticket that asks an agent to
// build the harness. Filing it afterwards, outside the write, was the bug: a failure to
// file left the mode already `pending`, and the retry — which files only on the transition — saw
// "already pending" and filed nothing, so the project sat in `pending` with no ticket and no way out
// but flipping the mode twice. Both rows are the API's (Invariant 5), so they can and must commit
// together. The caller hands in the ticket's columns; this decides whether to use them.
import {
  NO_DELIVERY_CONFIG,
  NO_DOCS_SOURCE,
  NO_QA_CONFIG,
  changedSteps,
  err,
  isEmptyStatusMap,
  isDeliveryMode,
  isDeliveryMoment,
  isDocsKind,
  isQaMode,
  ok,
  ciRequiredRefusal,
  deliverySinceAfter,
  qaCiRefusal,
  resolveDocsSource,
  statusMapOf,
  withStepTiers,
  type DeliveryConfigFields,
  type DocsSourceFields,
  type JiraPushFields,
  type JiraStatusMap,
  type JiraSourceFields,
  type QaConfigFields,
  type Result,
  type StepTiers,
  type StepTiersPatch,
} from "@bayon/core";
import {
  all,
  execute,
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { TicketRow, WorkspaceRow } from "../schema.js";
import { insertAudit } from "./audit.js";
import {
  planPushTargets,
  pushTargetsIn,
  writePushTargets,
  type PushTarget,
  type PushTargetPatch,
} from "./push-targets.js";
import { stepTierColumns, stepTiersOf } from "./step-tiers.js";
import { createTicketIn, type NewTicket } from "./ticket-writes.js";

export interface ProjectSettingsPatch {
  /** Whether the project's orchestrator only proposes its staffing, for the operator to approve. */
  readonly staff_approval?: boolean;
  /** The Jira source it mirrors, checked by the caller (proto JiraSource); null turns it off. */
  readonly jira?: JiraSourceFields | null;
  /** Its QA harness, checked by the caller (proto QaConfig); `mode: "none"` turns the gate off. */
  readonly qa?: QaConfigFields;
  /**
   * Where its documentation lives, checked by the caller (proto DocsSource); `kind: "none"` turns
   * the reader off. A `confluence` source with no `url` or no `email` takes the Jira source this
   * same call leaves — that is what "same as Jira" means; with no Jira source either it is refused
   * and nothing is written.
   */
  readonly docs?: DocsSourceFields;
  /**
   * How its finished work leaves, checked by the caller (proto DeliveryConfig).
   * `mode: "none"` is the default and turns delivery off. Setting anything else IS the standing
   * approval for the network writes the job makes (§14 amendment, the design §1.7) —
   * which is why it goes through this audited door and no other.
   */
  readonly delivery?: DeliveryConfigFields;
  /**
   * Where its repos' delivered work is pushed (migration 039), one entry per repo to change: a
   * checked https, ssh:// or scp-like URL, or null to push to the repo's origin_url again. Checked
   * here by core's `checkPushUrl`; a repo that is not the project's, or a refused URL, refuses the
   * whole patch and writes nothing.
   */
  readonly push_urls?: readonly PushTargetPatch[];
  /**
   * What goes back to the project's Jira issues, checked by the caller (proto
   * JiraPushConfig): the status each moment moves an issue to, and whether pull requests are
   * commented. Setting it IS the standing §14 approval for those writes to the operator's Jira.
   */
  readonly jira_push?: JiraPushFields;
  /**
   * The tier each step of its work runs (048), checked by the caller (proto
   * StepTiersPatch): a step named sets its tier, null inherits again, a step absent is kept.
   */
  readonly step_tiers?: StepTiersPatch;
  /**
   * Whether its sessions' model calls go through the context proxy (049; spec M12):
   * each one spawned after the change, where its adapter, executor and role allow it, and only on a
   * certificate earned with compression on.
   */
  readonly context_compression?: boolean;
  /**
   * The ticket to file, in this same transaction, when `qa.mode` moves to `pending`:
   * its columns as the caller compiled them, with `workspace_id` filled in here. Absent for every
   * other patch, and unused when the mode does not move.
   */
  readonly qaTicket?: NewTicket;
}

export interface ProjectSettingsChange {
  /** The project: its workspace's id. */
  readonly project: string;
  readonly staff_approval: boolean;
  readonly jira: JiraSourceFields | null;
  readonly qa: QaConfigFields;
  readonly docs: DocsSourceFields;
  readonly delivery: DeliveryConfigFields;
  readonly jira_push: JiraPushFields;
  /** The tier each step runs after the call; null inherits (048). */
  readonly step_tiers: StepTiers;
  /** Its context compression switch after the call (049). */
  readonly context_compression: boolean;
  /** Every repo's push target after the call, primary first (migration 039). */
  readonly push_targets: readonly PushTarget[];
  /** False when the project already had these values: nothing was written or audited. */
  readonly changed: boolean;
  /**
   * The harness ticket this call filed, in the same transaction as the mode that asked for it
   *; null when the mode did not move to `pending`, or no ticket was handed in. A
   * second PATCH with the mode already `pending` changes nothing, so it files nothing.
   */
  readonly qaTicket: TicketRow | null;
}

/** A workspace's Jira source, or null: the three columns are set together (033's CHECK). */
export function jiraSourceOf(
  w: Pick<WorkspaceRow, "jira_url" | "jira_email" | "jira_jql">,
): JiraSourceFields | null {
  return w.jira_url === null || w.jira_email === null || w.jira_jql === null
    ? null
    : { url: w.jira_url, email: w.jira_email, jql: w.jira_jql };
}

/** A JSON array of strings, parsed; anything else reads as empty rather than throwing. */
function stringList(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/** A workspace's QA harness, as stored. An unknown mode reads as `none`: 036's CHECK bars it. */
export function qaConfigOf(
  w: Pick<
    WorkspaceRow,
    | "qa_mode"
    | "qa_cmd"
    | "qa_timeout_ms"
    | "qa_secrets_json"
    | "qa_reports_json"
    | "qa_junit"
    | "qa_ci_checks_json"
    | "qa_ci_timeout_ms"
  >,
): QaConfigFields {
  return {
    mode: isQaMode(w.qa_mode) ? w.qa_mode : NO_QA_CONFIG.mode,
    cmd: w.qa_cmd,
    timeout_ms: w.qa_timeout_ms,
    secrets: stringList(w.qa_secrets_json),
    reports: stringList(w.qa_reports_json),
    junit: w.qa_junit,
    ci_checks: stringList(w.qa_ci_checks_json),
    ci_timeout_ms: w.qa_ci_timeout_ms,
  };
}

/** A workspace's documentation source, as stored. An unknown kind reads as `none`: 037's CHECK
 * bars it, and a reader that cannot name the product must not guess one. */
export function docsSourceOf(
  w: Pick<
    WorkspaceRow,
    "docs_kind" | "docs_url" | "docs_email" | "docs_spaces_json"
  >,
): DocsSourceFields {
  if (!isDocsKind(w.docs_kind) || w.docs_kind === "none") {
    return NO_DOCS_SOURCE;
  }
  return {
    kind: w.docs_kind,
    url: w.docs_url,
    email: w.docs_email,
    spaces: stringList(w.docs_spaces_json),
  };
}

/**
 * A workspace's delivery settings, as stored. An unknown mode or moment reads as "delivers
 * nothing": 038's CHECK bars both, and a row that somehow held one must not start pushing.
 */
export function deliveryConfigOf(
  w: Pick<WorkspaceRow, "delivery_mode" | "delivery_when" | "close_on_merge">,
): DeliveryConfigFields {
  return {
    mode: isDeliveryMode(w.delivery_mode)
      ? w.delivery_mode
      : NO_DELIVERY_CONFIG.mode,
    when: isDeliveryMoment(w.delivery_when)
      ? w.delivery_when
      : NO_DELIVERY_CONFIG.when,
    // 040's CHECK holds it to 0 or 1; anything but 0 is the default, on.
    close_on_merge: w.close_on_merge !== 0,
  };
}

/** A workspace's Jira push settings, as stored (041). An unreadable map moves nothing. */
export function jiraPushOf(
  w: Pick<WorkspaceRow, "jira_status_map_json" | "jira_comment_prs">,
): JiraPushFields {
  return {
    status_map: statusMapOf(w.jira_status_map_json),
    comment_prs: w.jira_comment_prs === 1,
  };
}

/** The map with its keys in a fixed order, so equal maps compare and store alike. */
const ordered = ({ status_map: m }: JiraPushFields): JiraStatusMap => ({
  ...(m.started === undefined ? {} : { started: m.started }),
  ...(m.in_review === undefined ? {} : { in_review: m.in_review }),
  ...(m.done === undefined ? {} : { done: m.done }),
});

/** The map as stored: NULL when it maps nothing. */
const mapJson = (p: JiraPushFields): string | null =>
  isEmptyStatusMap(p.status_map) ? null : JSON.stringify(ordered(p));

const samePush = (a: JiraPushFields, b: JiraPushFields): boolean =>
  a.comment_prs === b.comment_prs && mapJson(a) === mapJson(b);

/** The project's repos, by id: what a required CI entry's `<repo_id>:` prefix may name. */
const projectRepoIds = (ix: Internals, workspaceId: string): string[] =>
  all(
    ix,
    qb
      .selectFrom("workspace_repos")
      .select("repo_id")
      .where("workspace_id", "=", workspaceId)
      .orderBy("repo_id"),
  ).map((r) => r.repo_id);

const sameDelivery = (
  a: DeliveryConfigFields,
  b: DeliveryConfigFields,
): boolean =>
  a.mode === b.mode &&
  a.when === b.when &&
  a.close_on_merge === b.close_on_merge;

const list = (values: readonly string[]): string => JSON.stringify([...values]);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const sameQa = (a: QaConfigFields, b: QaConfigFields): boolean =>
  a.mode === b.mode &&
  a.cmd === b.cmd &&
  a.timeout_ms === b.timeout_ms &&
  a.junit === b.junit &&
  sameList(a.secrets, b.secrets) &&
  sameList(a.reports, b.reports) &&
  sameList(a.ci_checks, b.ci_checks) &&
  a.ci_timeout_ms === b.ci_timeout_ms;

const sameSource = (
  a: JiraSourceFields | null,
  b: JiraSourceFields | null,
): boolean =>
  a === null || b === null
    ? a === b
    : a.url === b.url && a.email === b.email && a.jql === b.jql;

const sameDocs = (a: DocsSourceFields, b: DocsSourceFields): boolean =>
  a.kind === b.kind &&
  a.url === b.url &&
  a.email === b.email &&
  sameList(a.spaces, b.spaces);

function writeSettings(
  ix: Internals,
  workspaceId: string,
  patch: ProjectSettingsPatch,
  actor: string,
): Result<ProjectSettingsChange> {
  if (actor.trim() === "") {
    return err(failure("validation", "a project change needs an actor"));
  }
  const row = first(
    ix,
    qb.selectFrom("workspaces").selectAll().where("id", "=", workspaceId),
  );
  if (row === undefined) {
    return err(failure("not_found", `project ${workspaceId} does not exist`));
  }
  const approval = row.staff_approval === 1;
  const source = jiraSourceOf(row);
  const qa = qaConfigOf(row);
  const docs = docsSourceOf(row);
  const delivery = deliveryConfigOf(row);
  const push = jiraPushOf(row);
  const approvalTo = patch.staff_approval ?? approval;
  const sourceTo = patch.jira === undefined ? source : patch.jira;
  const qaTo = patch.qa ?? qa;
  const deliveryTo = patch.delivery ?? delivery;
  // When delivery was turned on (047): set as it leaves `none`, cleared as it goes back,
  // kept between two ways of delivering. Only a change of the delivery settings moves it, so an
  // unrelated patch never starts or restarts delivery as a side effect.
  const sinceTo = sameDelivery(deliveryTo, delivery)
    ? row.delivery_since
    : deliverySinceAfter(
        delivery.mode,
        row.delivery_since,
        deliveryTo.mode,
        ix.clock.now(),
      );
  const pushTo = patch.jira_push ?? push;
  const steps = stepTiersOf(row);
  const stepsTo = withStepTiers(steps, patch.step_tiers ?? {});
  const stepsChanged = changedSteps(steps, stepsTo);
  const compression = row.context_compression === 1;
  const compressionTo = patch.context_compression ?? compression;
  // Resolved against the Jira source this call leaves, not the one it found: "same as Jira" follows
  // a mirror moved in the same PATCH.
  const resolved =
    patch.docs === undefined
      ? ok(docs)
      : resolveDocsSource(patch.docs, sourceTo);
  if (!resolved.ok) return resolved;
  const docsTo = resolved.value;
  // CI checks as QA need a pull request opened as review passes: refused on the QA
  // change that asks for it and on the delivery change that would take it away, with core's one
  // sentence — 043's CHECK is the backstop, never the message.
  const ciRefused =
    qaCiRefusal(qaTo.mode, deliveryTo) ??
    ciRequiredRefusal(qaTo.ci_checks, projectRepoIds(ix, workspaceId));
  if (ciRefused !== null) return err(failure("validation", ciRefused));
  const pushed =
    patch.push_urls === undefined
      ? ok({ changes: [], after: pushTargetsIn(ix, workspaceId) })
      : planPushTargets(ix, workspaceId, patch.push_urls);
  if (!pushed.ok) return pushed;
  const pushChanges = pushed.value.changes;
  // The harness ticket is filed only on the move INTO pending: a second PATCH with the same mode
  // changes nothing here, and so files nothing there either.
  const filesTicket = qaTo.mode === "pending" && qa.mode !== "pending";
  const state = {
    project: workspaceId,
    staff_approval: approvalTo,
    jira: sourceTo,
    qa: qaTo,
    docs: docsTo,
    delivery: deliveryTo,
    jira_push: pushTo,
    step_tiers: stepsTo,
    context_compression: compressionTo,
    push_targets: pushed.value.after,
  };
  // Only what changed; neither source holds a secret (the Jira token stays in the host store, and
  // `qa_secrets` is names only, §14).
  const payload = {
    ...(approvalTo === approval ? {} : { staff_approval: approvalTo }),
    ...(sameSource(sourceTo, source)
      ? {}
      : {
          jira:
            sourceTo === null
              ? null
              : { url: sourceTo.url, email: sourceTo.email, jql: sourceTo.jql },
        }),
    ...(sameQa(qaTo, qa)
      ? {}
      : {
          qa: {
            mode: qaTo.mode,
            cmd: qaTo.cmd,
            timeout_ms: qaTo.timeout_ms,
            secrets: [...qaTo.secrets],
            reports: [...qaTo.reports],
            junit: qaTo.junit,
            ci_checks: [...qaTo.ci_checks],
            ci_timeout_ms: qaTo.ci_timeout_ms,
          },
        }),
    // No secret here either: the reader uses the Jira mirror's own host-store token (§14).
    ...(sameDocs(docsTo, docs)
      ? {}
      : {
          docs: {
            kind: docsTo.kind,
            url: docsTo.url,
            email: docsTo.email,
            spaces: [...docsTo.spaces],
          },
        }),
    // The delivery payload is the §14 record: what the operator approved, and when.
    ...(sameDelivery(deliveryTo, delivery)
      ? {}
      : {
          delivery: {
            mode: deliveryTo.mode,
            when: deliveryTo.when,
            close_on_merge: deliveryTo.close_on_merge,
          },
        }),
    // What the operator approved Bayon to write back to Jira: status names and a switch (§14).
    ...(samePush(pushTo, push)
      ? {}
      : {
          jira_push: {
            status_map: ordered(pushTo),
            comment_prs: pushTo.comment_prs,
          },
        }),
    // The steps whose tier moved, each to its tier or null (inherit): what a spawn will run (048).
    ...(stepsChanged.length === 0
      ? {}
      : {
          step_tiers: Object.fromEntries(
            stepsChanged.map((step) => [step, stepsTo[step]]),
          ),
        }),
    // Whether the sessions spawned from now on run through the context proxy (049).
    ...(compressionTo === compression
      ? {}
      : { context_compression: compressionTo }),
    // Where the approved delivery now goes: a checked URL, never a credential (039, §14).
    ...(pushChanges.length === 0
      ? {}
      : {
          push_urls: pushChanges.map((c) => ({
            repo_id: c.repo_id,
            push_url: c.push_url,
          })),
        }),
  };
  if (Object.keys(payload).length === 0)
    return ok({ ...state, changed: false, qaTicket: null });
  execute(
    ix,
    qb
      .updateTable("workspaces")
      .set({
        staff_approval: approvalTo ? 1 : 0,
        jira_url: sourceTo?.url ?? null,
        jira_email: sourceTo?.email ?? null,
        jira_jql: sourceTo?.jql ?? null,
        qa_mode: qaTo.mode,
        // 036's CHECK refuses a blank command in `command` mode; a blank one in any other mode is
        // cleared rather than kept, so turning the gate off leaves nothing behind to re-run.
        qa_cmd: qaTo.mode === "none" ? null : (qaTo.cmd ?? "").trim() || null,
        qa_timeout_ms: qaTo.timeout_ms,
        qa_secrets_json: list(qaTo.secrets),
        qa_reports_json: list(qaTo.reports),
        qa_junit: qaTo.junit,
        qa_ci_checks_json: list(qaTo.ci_checks),
        qa_ci_timeout_ms: qaTo.ci_timeout_ms,
        docs_kind: docsTo.kind,
        docs_url: docsTo.url,
        docs_email: docsTo.email,
        docs_spaces_json: list(docsTo.spaces),
        delivery_mode: deliveryTo.mode,
        delivery_when: deliveryTo.when,
        close_on_merge: deliveryTo.close_on_merge ? 1 : 0,
        delivery_since: sinceTo,
        jira_status_map_json: mapJson(pushTo),
        jira_comment_prs: pushTo.comment_prs ? 1 : 0,
        ...stepTierColumns(stepsTo),
        context_compression: compressionTo ? 1 : 0,
      })
      .where("id", "=", workspaceId),
  );
  writePushTargets(ix, pushChanges);
  const audit = insertAudit(ix, {
    actor,
    action: "project.set",
    target_kind: "project",
    target_id: workspaceId,
    payload,
  });
  if (!audit.ok) return audit;
  if (!filesTicket || patch.qaTicket === undefined) {
    return ok({ ...state, changed: true, qaTicket: null });
  }
  // In this transaction: if the insert fails, the mode never became `pending`, and the operator can
  // simply ask again. That is the whole of the fix.
  const filed = createTicketIn(
    ix,
    { ...patch.qaTicket, workspace_id: workspaceId },
    { actor_kind: "operator", actor_id: actor },
  );
  if (!filed.ok) return filed;
  const asked = insertAudit(ix, {
    actor,
    action: QA_HARNESS_ACTION,
    target_kind: "ticket",
    target_id: filed.value.id,
    payload: { project: workspaceId },
  });
  return asked.ok
    ? ok({ ...state, changed: true, qaTicket: filed.value })
    : asked;
}

/** The audit row the "build one for me" request leaves, beside `project.set`'s. */
export const QA_HARNESS_ACTION = "project.qa_harness_requested";

/**
 * Sets project `workspaceId`'s staffing approval, Jira source, QA harness, documentation source,
 * delivery, push targets, Jira push, step tiers and context compression, each when `patch` names it, audited `project.set` as `actor`'s with the fields that
 * changed. The values it already has change nothing. Refused, writing nothing: an unknown project
 * (not_found), an empty actor (validation), a documentation source with no site or account and no
 * Jira source to take them from (validation). Proposals already open stay open either way; tickets already mirrored stay when the
 * source goes; and a QA mode turned off leaves the runs it already recorded (§10.4's history).
 */
export function setProjectSettings(
  db: Db,
  workspaceId: string,
  patch: ProjectSettingsPatch,
  actor: string,
): R<ProjectSettingsChange> {
  return write(db, (ix) => writeSettings(ix, workspaceId, patch, actor));
}
