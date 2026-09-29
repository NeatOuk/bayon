// `frm project add <name> --repo <url|path> --runner <id>`: the single-repo,
// one-builder(-one-orchestrator) shape of `frm config apply`, without hand-writing the JSON. A repo
// (mirror path filled in, not created), one workspace, a build profile and a builder agent; unless
// --no-orchestrator, an orchestrate profile and an orchestrator agent (default pulse policy, no
// mission: POST /missions staffs it); unless --no-reviewer, a review profile and a reviewer agent on
// --reviewer-runner (default --runner), whom a gate's review runs as. All through
// @bayon/db/operator, in one transaction, audited. The id/staff/row planning is `@bayon/core`'s
// (`projectIds`/`projectStaff`/`projectPlan`) and the profile defaults `@bayon/proto`'s
// (`withProfileDefaults`): `POST /projects` shares both, so the two doors can never
// drift on what a project's rows are. No profile states permission_json: each session gets its
// role's core command policy, a reviewer's read-only git included. --dry-run opens no
// database at all.
// --runner names a runner the operator already registered: Invariant 1 (no runner/provider string
// outside packages/runners/<adapter>) means this file never guesses or hardcodes one as a default.
// Exit codes: 0 written (or the dry-run print), 1 refused by the database or an existing name,
// 2 bad usage or no FRM_HOME.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  PROJECT_NAME,
  RunnerCaps,
  checkProjectName,
  err,
  ok,
  projectIds,
  projectPlan,
  projectStaff,
  systemClock,
  type ProjectIds,
  type ProjectPlanInput,
  type Result,
} from "@bayon/core";
import {
  agentModels,
  getLiveCertification,
  getRepo,
  getRunner,
  openDb,
  type Db,
} from "@bayon/db";
import { migrateUp, seedConfig, type ConfigRows } from "@bayon/db/operator";
import { withProfileDefaults, type Row } from "@bayon/proto";

const DEFAULT_EXECUTOR = "local";

const USAGE_LINE =
  "frm project add <name> --repo <url|path> --runner <id> [--executor <id>] [--base <branch>] [--reviewer-runner <id> | --no-reviewer] [--no-orchestrator] [--dry-run]";

export const PROJECT_ADD_USAGE = [
  `       ${USAGE_LINE}`,
  "project add: a repo (mirror path under $FRM_HOME/mirrors, cloned on first use), one workspace,",
  "  a build profile and a builder agent; unless --no-orchestrator, an orchestrate profile and an",
  "  orchestrator agent (default pulse policy; no mission, POST /missions staffs it); unless",
  "  --no-reviewer, a review profile and a reviewer agent on --reviewer-runner (default --runner),",
  "  whom gate reviews run as. In $FRM_DB (else $FRM_HOME/foreman.db), through @bayon/db/operator,",
  `  audited. <name> must match ${PROJECT_NAME.source} and not already name a repo. --runner names one`,
  "  the supervisor already registered (no default: frm never guesses a runner); --executor defaults",
  `  to ${DEFAULT_EXECUTOR}. Warns and prints the certify command when a pair is not certified (the`,
  "  write still happens: admission's require_certified is the real gate), and warns when the",
  "  reviewer's runner has no structured output: code reviews need one bound to code_reviewer.",
  "  --dry-run prints the rows it would write and opens no database.",
].join("\n");

export interface ProjectAddCommand {
  readonly name: string;
  readonly repo: string;
  readonly runner: string;
  readonly executor: string;
  readonly base?: string;
  readonly orchestrator: boolean;
  /** The reviewer agent's runner; null: --no-reviewer. */
  readonly reviewerRunner: string | null;
  readonly dryRun: boolean;
}

export type { ProjectIds };

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** `cmd` as core's plan input: `@bayon/core`'s `projectIds`/`projectStaff`/`projectPlan` take this
 * shape, not the CLI's own (`repo` here, `repoUrl` there). */
const planInputOf = (cmd: ProjectAddCommand): ProjectPlanInput => ({
  name: cmd.name,
  repoUrl: cmd.repo,
  runner: cmd.runner,
  executor: cmd.executor,
  orchestrator: cmd.orchestrator,
  reviewerRunner: cmd.reviewerRunner,
  ...(cmd.base === undefined ? {} : { base: cmd.base }),
});

const FLAGS = {
  repo: { type: "string" },
  runner: { type: "string" },
  executor: { type: "string" },
  base: { type: "string" },
  "reviewer-runner": { type: "string" },
  "no-reviewer": { type: "boolean", default: false },
  "no-orchestrator": { type: "boolean", default: false },
  "dry-run": { type: "boolean", default: false },
} as const;

function readFlags(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: FLAGS,
      }),
    );
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "bad arguments");
  }
}

/** `frm project add <name> …`: argv from the command word on. */
export function parseProjectAddCli(
  argv: readonly string[],
): Result<ProjectAddCommand> {
  const [word, action, ...rest] = argv;
  if (word !== "project" || action !== "add")
    return invalid(`usage: ${USAGE_LINE}`);
  const read = readFlags(rest);
  if (!read.ok) return read;
  const { values, positionals } = read.value;
  const [name, ...extra] = positionals;
  if (name === undefined || extra.length > 0)
    return invalid(`usage: ${USAGE_LINE}`);
  const nameCheck = checkProjectName(name);
  if (!nameCheck.ok) return nameCheck;
  if (values.repo === undefined || values.repo === "")
    return invalid("--repo <url|path> is required");
  if (values.runner === undefined || values.runner === "")
    return invalid("--runner <id> is required");
  const reviewer = values["reviewer-runner"];
  if (values["no-reviewer"] && reviewer !== undefined)
    return invalid("--reviewer-runner and --no-reviewer conflict");
  if (reviewer === "") return invalid("--reviewer-runner <id> needs an id");
  return ok({
    name,
    repo: values.repo,
    runner: values.runner,
    executor: values.executor ?? DEFAULT_EXECUTOR,
    orchestrator: !values["no-orchestrator"],
    reviewerRunner: values["no-reviewer"] ? null : (reviewer ?? values.runner),
    dryRun: values["dry-run"],
    ...(values.base === undefined ? {} : { base: values.base }),
  });
}

/** repos.id = workspaces.id = <name>; every other id is derived, nothing asked twice. */
export const idsOf = (cmd: ProjectAddCommand): ProjectIds =>
  projectIds(planInputOf(cmd));

/** The `ConfigRows` `seedConfig` writes for `cmd`: reused by `--dry-run` and the real write, so
 * they can never drift on what a run would do. No database access. */
export async function toConfigRows(
  cmd: ProjectAddCommand,
  ids: ProjectIds,
  home: string,
  now: number,
): Promise<ConfigRows> {
  const plan = projectPlan(planInputOf(cmd), ids);
  // No permission_json: the session's role picks its core command policy.
  const profiles = await Promise.all(
    plan.profiles.map((p) => withProfileDefaults(p as unknown as Row, now)),
  );
  const agents = plan.agents.map((a) => ({ ...a, created_at: now }));
  return {
    repos: [
      {
        ...plan.repo,
        mirror_path: join(home, "mirrors", `${ids.repo}.git`),
      },
    ],
    workspaces: [plan.workspace],
    workspace_repos: [plan.workspaceRepo],
    profiles: profiles as unknown as ConfigRows["profiles"],
    agents,
  };
}

const TABLES = [
  "repos",
  "workspaces",
  "workspace_repos",
  "profiles",
  "agents",
] as const;

const counted = (rows: ConfigRows): string =>
  TABLES.map((t) => `${(rows[t] ?? []).length} ${t}`).join(", ");

const certifyHint = (
  runnerId: string,
  modelId: string,
  executorId: string,
): string =>
  `frm runner conformance ${runnerId} --model ${modelId} --executor ${executorId}`;

const runnersOf = (cmd: ProjectAddCommand, ids: ProjectIds): string[] => [
  ...new Set([
    cmd.runner,
    ...(ids.reviewer === null ? [] : [ids.reviewer.runner]),
  ]),
];

const noSchemaWarning = (runnerId: string): string =>
  `warning     ${runnerId} has no structured output: plan reviews will run, but code reviews need a runner with structured output bound to code_reviewer`;

function describe(
  cmd: ProjectAddCommand,
  ids: ProjectIds,
  rows: ConfigRows,
  out: (line: string) => void,
): void {
  const staff = projectStaff(planInputOf(cmd), ids);
  out(`project ${cmd.name}: ${counted(rows)}`);
  out(`  repo        ${ids.repo}  ${cmd.repo}`);
  out(`  workspace   ${ids.workspace}  single`);
  out(`  profile     ${staff.map((s) => s.profile).join(", ")}`);
  out(`  agent       ${staff.map((s) => s.id).join(", ")}`);
  if (ids.reviewer !== null) {
    out(
      `  reviewer    ${ids.reviewer.agent} on ${ids.reviewer.runner}: read-only git (the core reviewer policy)`,
    );
  }
}

function nextStep(ids: ProjectIds): string {
  return ids.orchestrator === null
    ? `next        stand up a session on ${ids.builder}`
    : `next        stand up a session on ${ids.builder}, or POST /missions to staff ${ids.orchestrator.agent}`;
}

/** Every runner the project's agents run on, once each. */

/**
 * Whether the runner declares structured output (`runners.caps_json`, §5.1): what code_review's
 * pick requires (). Caps that are not the §5.1 matrix read as none, so the operator is
 * warned rather than told nothing.
 */
async function hasOutputSchema(
  db: Db,
  runnerId: string,
): Promise<Result<boolean>> {
  const runner = await getRunner(db, runnerId);
  if (!runner.ok) return runner;
  let caps: unknown;
  try {
    caps = JSON.parse(runner.value.caps_json);
  } catch {
    return ok(false);
  }
  const parsed = RunnerCaps.pick({ outputSchema: true }).safeParse(caps);
  return ok(parsed.success && parsed.data.outputSchema);
}

export interface ProjectAddIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/**
 * The (runner, model) each new agent runs (certification is per model), once each;
 * an agent whose tier resolves to no active model is its own warning.
 */
async function staffedModels(
  db: Db,
  cmd: ProjectAddCommand,
  ids: ProjectIds,
  io: ProjectAddIo,
): Promise<Map<string, { runner: string; model: string }>> {
  const models = await agentModels(db);
  const pairs = new Map<string, { runner: string; model: string }>();
  if (!models.ok) {
    io.err(
      `frm project add: could not read the agents' models: ${models.error.message}`,
    );
    return pairs;
  }
  const byAgent = new Map(models.value.map((m) => [m.agent_id, m.model_id]));
  for (const s of projectStaff(planInputOf(cmd), ids)) {
    const model = byAgent.get(s.id) ?? null;
    if (model === null) {
      io.out(`warning     ${s.id} runs no active model of runner ${s.runner}`);
    } else {
      pairs.set(`${s.runner}\u0000${model}`, { runner: s.runner, model });
    }
  }
  return pairs;
}

/** After the write: each uncertified (runner, model)'s certify command, and a reviewer without structured output. */
async function warnings(
  db: Db,
  cmd: ProjectAddCommand,
  ids: ProjectIds,
  io: ProjectAddIo,
): Promise<void> {
  for (const { runner, model } of (
    await staffedModels(db, cmd, ids, io)
  ).values()) {
    // A project frm adds runs uncompressed (the switch is the API's to turn on).
    const live = await getLiveCertification(
      db,
      runner,
      cmd.executor,
      model,
      false,
    );
    if (!live.ok) {
      io.err(
        `frm project add: could not check certification: ${live.error.message}`,
      );
    } else if (live.value === null) {
      io.out(
        `warning     not certified: ${certifyHint(runner, model, cmd.executor)}`,
      );
    }
  }
  if (ids.reviewer === null) return;
  const schema = await hasOutputSchema(db, ids.reviewer.runner);
  if (!schema.ok) {
    io.err(
      `frm project add: could not read ${ids.reviewer.runner}'s caps: ${schema.error.message}`,
    );
  } else if (!schema.value) {
    io.out(noSchemaWarning(ids.reviewer.runner));
  }
}

/** Runs `frm project add`. */
export async function runProjectAddCommand(
  cmd: ProjectAddCommand,
  io: ProjectAddIo,
): Promise<number> {
  const home = io.env["FRM_HOME"];
  if (home === undefined || home === "") {
    io.err("frm project add: set FRM_HOME");
    return 2;
  }
  const ids = idsOf(cmd);
  const now = systemClock.now();
  if (cmd.dryRun) {
    const rows = await toConfigRows(cmd, ids, home, now);
    describe(cmd, ids, rows, io.out);
    // No database to check: a fresh FRM_HOME has no certification or runner rows either way.
    for (const runnerId of runnersOf(cmd, ids)) {
      io.out(
        `warning     frm runner conformance ${runnerId} --executor ${cmd.executor} (every model a role binds; not checked: --dry-run)`,
      );
    }
    if (ids.reviewer !== null) {
      io.out(
        `warning     code reviews need structured output on ${ids.reviewer.runner} (not checked: --dry-run)`,
      );
    }
    return 0;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const opened = await openDb({
    path: io.env["FRM_DB"] ?? join(home, "foreman.db"),
    clock: systemClock,
  });
  if (!opened.ok) {
    io.err(`frm project add: ${opened.error.message}`);
    return 1;
  }
  const db = opened.value;
  try {
    const migrated = await migrateUp(db, {});
    if (!migrated.ok) {
      io.err(`frm project add: ${migrated.error.message}`);
      return 1;
    }
    const existing = await getRepo(db, ids.repo);
    if (existing.ok) {
      io.err(`project ${cmd.name} already exists (repo ${ids.repo})`);
      return 1;
    }
    if (existing.error.class !== "not_found") {
      io.err(`frm project add: ${existing.error.message}`);
      return 1;
    }
    const rows = await toConfigRows(cmd, ids, home, now);
    const seeded = await seedConfig(db, rows);
    if (!seeded.ok) {
      io.err(`frm project add: nothing written: ${seeded.error.message}`);
      return 1;
    }
    describe(cmd, ids, rows, io.out);
    await warnings(db, cmd, ids, io);
    io.out(nextStep(ids));
    return 0;
  } finally {
    await db.close();
  }
}
