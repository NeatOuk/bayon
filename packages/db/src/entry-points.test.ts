import { expect, test } from "vitest";
import * as api from "./api.js";
import * as reads from "./index.js";
import * as operator from "./operator.js";
import * as supervisor from "./supervisor.js";

// §9.5 writer discipline for the work tables (M1 plan, contract 1): each writer is exported from
// its owner's entry point and from no other, so an app can reach only its own writers.
const API_WRITERS = [
  "acceptHandoff",
  "answerHumanRequest",
  // POST /inbox/:id/answer on a staffing proposal: the answer, and an approval's staffing.
  "answerStaffProposal",
  "appendKnowledge",
  "appendTicketEvent",
  // human_ask's batch: the requests, with the open ones a repeat returns.
  "askHumanRequests",
  // the notifier's outbox: a delivery claimed before its send, deferred, settled.
  "claimDelivery",
  // the Jira pusher's outbox: filed once by key, claimed, settled.
  "claimJiraPush",
  // POST /executors: one executor row, the second, narrower door alongside createProject.
  "createExecutor",
  // POST /projects: the repo/workspace/profile/agent rows, one door.
  "createProject",
  // POST /projects/:id/agents: one more builder, reviewer or orchestrator,
  // and at most its profile.
  "createProjectAgent",
  "createTicket",
  // DELETE /runners/:id/models/:model: the operator's deactivation, audited.
  "deactivateOperatorModel",
  "deferDelivery",
  // budgets (012, M4): the operator's config through REST.
  "deleteBudget",
  // POST /inbox/:id/dismiss: the operator withdraws a question no longer relevant.
  "dismissHumanRequest",
  // POST /runners/:id/updates/:version/dismiss: the operator's dismissal, audited.
  "dismissRunnerUpdate",
  "fileJiraPushes",
  "insertHumanRequest",
  // the notifier's outbox: notifications filed once by key, with their watermarks.
  "insertNotifications",
  "linkTicket",
  "markMessagesRead",
  // the Jira mirror: a page of issues into a project's tickets, and the departed parked.
  "mirrorJiraPage",
  "parkDepartedJira",
  "putBudget",
  // the kill switch and the whitelisted settings (M4).
  // POST/PATCH /runners/:id/models: an operator model, the tier rule, audited.
  "putOperatorModel",
  "putOperatorSettings",
  "putRoleBinding",
  "rerunGate",
  "resolveFinding",
  "sendMessage",
  // PATCH /agents/:id: enabled and max_concurrency; frm's own door is setAgentFromCli.
  "setAgentFromApi",
  "setFleetPaused",
  // POST /projects/:id/pause|resume: one project's workspaces.paused.
  "setProjectPaused",
  // PATCH /projects/:id: workspaces.staff_approval and the Jira source.
  "setProjectSettings",
  "setPulsePolicy",
  "settleDelivery",
  "settleJiraPush",
  "staffTicket",
  "transitionTicket",
  "updateTicketCas",
  "waiveFinding",
  "waiveGate",
  "writeHandoffJudgement",
];
/** ticket_exports is written by the exporter's script runner (amendment 5); prompt_templates at
 * boot (M2 amendment); pulse_checks by the probe runner's callers (M2); the hand-off facts
 * columns (M2 rule 2); pulses by the scheduler; a successor's worktree
 *. */
const SUPERVISOR_WRITERS = [
  // advanceTicket: the machine steps after a gate decides (rule 2).
  "advanceTicket",
  "applyPulseReport",
  // blockTicket and insertSystemHumanRequest: the watchdog's writers (M4, rule 2).
  "blockTicket",
  // a pending "take over after this step": set and cleared on the sessions row.
  "clearAttachIntent",
  // the worktree sweep's flag and removal (M4).
  "clearWorktreeFlag",
  "closeConformanceProbe",
  // commitDelivery and recordDelivery: what a ticket's work reached on its project's own remote
  // (§9.5 amendment) — with `tickets.pr_url` and its `ticket_links`, the third named
  // supervisor ticket write beside blockTicket and advanceTicket.
  "commitDelivery",
  "decertifyPairs",
  // decideGate: the supervisor's one gate writer (M3 rule 2).
  "decideGate",
  // retention: archived events leave the table.
  "deleteArchivedEvents",
  "finalizeHandoffPacket",
  "flagWorktree",
  "insertHandoffFacts",
  "insertPulseChecks",
  "insertSystemHumanRequest",
  "leasePulse",
  "markWorktreeRemoved",
  "openConformanceProbe",
  "reassignWorktree",
  // backups (012, M4): the nightly backup is a daemon job.
  "recordBackup",
  // recordCiProgress: a CI gate's read of its pull requests' checks, on deliveries.
  "recordCiProgress",
  "recordDelivery",
  // the runner update check's job: upserts by (runner_id, latest) on every check.
  "recordRunnerUpdate",
  "releaseExpiredPulseLeases",
  "resumPulseCosts",
  "sealHandoff",
  "seedConformanceScratch",
  "setAttachIntent",
  // settlePullRequests: a pull request's merge or close, and merge_close with it —
  // the fourth named supervisor ticket write, through advanceTicketIn.
  "settlePullRequests",
  "settlePulse",
  "storeCertification",
  "updatePulse",
  "upsertPromptTemplates",
  "upsertTicketExport",
];

/** tools/frm's writers (Invariant 5's one exception): config rows, and its own backup attempts. */
const OPERATOR_WRITERS = [
  "recordOperatorBackup",
  "restoreBackup",
  "seedConfig",
  // frm agent set: an existing agent's profile, enabled, max_concurrency.
  "setAgentFromCli",
  "setExecutorConfig",
  // frm executor enable|disable: the executor's enabled flag.
  "setExecutorEnabledFromCli",
  // frm pause|resume when the API is down.
  "setFleetPausedFromCli",
  // frm settings set: one governed setting, the shell door to the security controls.
  "setSettingFromCli",
];

const names = (entry: object) => Object.keys(entry);
const among = (entry: object, wanted: readonly string[]) =>
  names(entry)
    .filter((name) => wanted.includes(name))
    .toSorted();

test("the API's work writers are exported from @bayon/db/api only", () => {
  expect(among(api, API_WRITERS)).toEqual(API_WRITERS);
  for (const entry of [reads, supervisor, operator]) {
    expect(among(entry, API_WRITERS)).toEqual([]);
  }
});

test("the supervisor's work writer is exported from @bayon/db/supervisor only", () => {
  expect(among(supervisor, SUPERVISOR_WRITERS)).toEqual(SUPERVISOR_WRITERS);
  for (const entry of [reads, api, operator]) {
    expect(among(entry, SUPERVISOR_WRITERS)).toEqual([]);
  }
});

test("the operator's writers are exported from @bayon/db/operator only", () => {
  expect(among(operator, OPERATOR_WRITERS)).toEqual(OPERATOR_WRITERS);
  for (const entry of [reads, api, supervisor]) {
    expect(among(entry, OPERATOR_WRITERS)).toEqual([]);
  }
});

test("the encrypted backup is written from the supervisor's and the operator's entries only", () => {
  expect(names(supervisor)).toContain("writeBackup");
  expect(names(operator)).toContain("writeBackup");
  expect(names(reads)).not.toContain("writeBackup");
  expect(names(api)).not.toContain("writeBackup");
});

test("@bayon/db exports no writer", () => {
  const writerLike =
    /^(?:create|update|insert|append|upsert|set|send|link|transition|claim|complete|finish|release|seed|migrate(?:Up|Down)$)/;
  expect(names(reads).filter((name) => writerLike.test(name))).toEqual([]);
});
