// `frm config apply <file.json>`: the operator's repos, workspaces, profiles and agents
// from one JSON file, through the same seedConfig the smokes use (@bayon/db/operator, Invariant 5).
// One transaction: a missing parent, a repeated id or an unknown column writes nothing, and the
// error names it. Executors are not here: `frm executor add` pins their host key.
// Exit codes: 0 applied, 1 refused by the database, 2 bad usage or a bad file.
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  GATE_SETTING_KEYS,
  canonicalJson,
  err,
  lintArgv,
  ok,
  systemClock,
  type Result,
} from "@bayon/core";
import { getAgent, getExecutor, getRunner, openDb, type Db } from "@bayon/db";
import { migrateUp, seedConfig, type ConfigRows } from "@bayon/db/operator";
import { ModelInput, Row, withProfileDefaults } from "@bayon/proto";
import { z } from "zod";
import { LINT, lintRows } from "./lint-config.js";
import { QA, qaRows } from "./qa-config.js";
import { PARITY, parityRows } from "./parity-config.js";
import { planModels, runModelsList } from "./config-models.js";

export const CONFIG_USAGE = [
  "       frm config apply <file.json> [--yes]",
  "       frm models list [runner]",
  "config apply: one JSON object keyed by table (repos, workspaces, workspace_repos, profiles,",
  "  agents, run_classes, models, settings), each a list of rows with the table's columns; settings is an",
  "  object of key: value. Inserted in one transaction into $FRM_DB (else $FRM_HOME/foreman.db);",
  "  run_classes and settings are upserted. *_json columns take JSON values. Filled in when absent:",
  "  repos.mirror_path ($FRM_HOME/mirrors/<id>.git), profiles.version (1) and hash, created_at, and",
  "  profiles.tool_allowlist_json: every MCP tool, so each session's role decides what it mounts.",
  "  An explicit [] mounts none, and admission refuses a work role's spawn on it (no_tools).",
  "  profiles.permission_json left empty: each session gets its role's default command policy at",
  "  spawn (a builder's git work, base updates, node and the package manager); git push, remote and",
  "  config are denied to every session. settings.agents.git_author: `Name <email>` agents commit as.",
  "  Profiles and agents name a runner the supervisor registered at its boot. The parity and lint",
  "  checkers' run classes, profiles and kind='util' agents are seeded too when this install has",
  "  none: without them those gates have no job to run the moment an operator turns one on. A file",
  "  that turns gates.lint_check or gates.parity_check on while its checker cannot be seeded yet is",
  "  refused and writes nothing: boot the supervisor and apply it again.",
  "  repos.lint_cmd and repos.install_cmd are what the lint_check gate runs: argv, no shell, and",
  "  checked here rather than when a gate first opens.",
  "  models: the operator's own rows {id, runner_id, tier, model, effort?, price_in_per_mtok,",
  "  price_out_per_mtok (0 is a price), price_cache_read/write_per_mtok? (default: the input",
  "  price), context_tokens?, settings?, active?}, each checked by its runner's adapter; the",
  "  supervisor must have booted once so the runner is registered. Boot never overwrites one. An",
  "  active row takes its (runner, tier) from the adapter's row there; a second active operator",
  "  row in a tier is refused. A row whose settings change (a provider URL directs network",
  "  egress) is shown and written only with --yes. A row's model string is fixed once stored.",
  "models list: every non-retired model, or one runner's: tier, prices, source, settings.",
].join("\n");

export type ConfigCommand =
  | {
      readonly action: "apply";
      readonly file: string;
      /** Consent to the settings changes the file makes. */
      readonly yes: boolean;
    }
  | { readonly action: "models"; readonly runner?: string };

const Rows = z.array(Row).optional();
const ConfigFile = z.strictObject({
  repos: Rows,
  workspaces: Rows,
  workspace_repos: Rows,
  profiles: Rows,
  agents: Rows,
  run_classes: Rows,
  models: z.array(ModelInput).optional(),
  settings: z.record(z.string(), z.json()).optional(),
});
type ConfigFile = z.infer<typeof ConfigFile>;

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** `frm config apply <file> [--yes]` or `frm models list [runner]`: argv from the command word on. */
export function parseConfigCli(argv: readonly string[]): Result<ConfigCommand> {
  const [word, action, ...rest] = argv;
  if (word === "models") {
    const [runner, ...extra] = rest;
    if (action !== "list" || extra.length > 0)
      return invalid("usage: frm models list [runner]");
    return ok({
      action: "models",
      ...(runner === undefined ? {} : { runner }),
    });
  }
  const yes = rest.includes("--yes");
  const [file, ...more] = rest.filter((a) => a !== "--yes");
  if (
    word !== "config" ||
    action !== "apply" ||
    file === undefined ||
    file.startsWith("--") ||
    more.length > 0
  )
    return invalid("usage: frm config apply <file.json> [--yes]");
  return ok({ action: "apply", file: resolve(file), yes });
}

/** *_json columns hold canonical JSON text; the file may give them as JSON values. */
const jsonColumns = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      k.endsWith("_json") && typeof v !== "string" ? canonicalJson(v) : v,
    ]),
  );

/** The job rows this apply adds, and the line the operator is told about them. */
interface JobPlan {
  readonly rows: ConfigRows;
  readonly note: string;
  /**
   * The job has no agent and this apply cannot seed one. Set means the gate this job decides has no
   * reviewer after this apply: the note is a warning on stderr, and turning the job's switch on in
   * the same file is refused (`stalls`).
   */
  readonly unseeded?: string;
}

const NOTHING: JobPlan = { rows: {}, note: "" };

/** One script job's identity, as this file needs it. */
interface JobSpec {
  readonly name: string;
  readonly agentId: string;
  readonly runnerId: string;
  readonly executor: string;
  /**
   * The `settings` key that makes this job's gate required (§10.3; 020 and 024 seed both false), or
   * null for a job whose gate is switched on per project rather than per fleet (QA:
   * `workspaces.qa_mode`, which a config file does not carry). A job with no key can still warn,
   * but no file can be refused for turning on a switch it cannot name.
   */
  readonly setting: string | null;
  readonly rows: (o: {
    readonly now: number;
    readonly home: string;
  }) => Promise<ConfigRows>;
}

const JOBS: readonly JobSpec[] = [
  {
    name: "parity checker",
    ...PARITY,
    setting: GATE_SETTING_KEYS.parity_check,
    rows: parityRows,
  },
  {
    name: "lint checker",
    ...LINT,
    setting: GATE_SETTING_KEYS.lint_check,
    rows: lintRows,
  },
  {
    name: "QA checker",
    ...QA,
    // Per project, not per fleet: a project turns its own harness on in its Settings view.
    setting: null,
    rows: qaRows,
  },
];

/** `not_found` is an answer here; anything else is a database the apply must not write to. */
const missing = <T>(looked: Result<T>): Result<boolean> =>
  looked.ok
    ? ok(false)
    : looked.error.class === "not_found"
      ? ok(true)
      : looked;

/**
 * One script job's own rows, when this install has none and can hold them.
 *
 * `gates.parity_check` and `gates.lint_check` are each one setting away from being on, and with one
 * on its pick answers `no_reviewer` — a required gate nobody can decide — until a `kind='util'`
 * agent of that job exists. Nothing seeded one: `parityRows` had no caller but the M3 smoke, so no
 * real deployment ever had the agent. `config apply` is the one operator flow that writes fleet
 * config, so it does.
 *
 * Two conditions, both about not breaking the apply the operator actually asked for:
 *
 *   - **Only when the agent is absent — from the database *and* from the file.** `seedConfig`
 *     inserts profiles and agents plainly, so a second `apply` would conflict on the id and write
 *     *nothing at all* — the operator's whole file lost to a row they never asked for. Reading only
 *     the database prevented that on the *second* apply and not on the first: an operator
 *     re-applying an exported file, or declaring `agents:[{id:"lint-checker"…}]` themselves, got
 *     the shipped row appended beside their own and the whole apply lost to the conflict. An
 *     install that owns the agent, in either place, keeps its own.
 *   - **Only when the runner and the executor exist.** The profile and the agent have foreign keys
 *     to both, and neither is an operator row: the supervisor registers the runner from its own
 *     adapter at boot, and the executor comes from `frm executor add`. Applying a config file
 *     before the daemon's first boot is normal, and must not fail on rows the file never named —
 *     so they are skipped, the operator is told on stderr to apply again once the fleet is up, and
 *     `stalls` refuses the one file that would turn the gate on anyway.
 */
async function jobPlan(
  db: Db,
  job: JobSpec,
  file: ConfigFile,
  home: string,
  now: number,
): Promise<Result<JobPlan>> {
  // The file's own rows are about to be inserted in this same transaction, so a row it declares is
  // as present as one already stored — and colliding with it is the failure this guard exists for.
  if (declares(file, job.agentId)) return ok(NOTHING);
  const noAgent = missing(await getAgent(db, job.agentId));
  if (!noAgent.ok) return noAgent;
  if (!noAgent.value) return ok(NOTHING);
  const noRunner = missing(await getRunner(db, job.runnerId));
  if (!noRunner.ok) return noRunner;
  const noExecutor = missing(await getExecutor(db, job.executor));
  if (!noExecutor.ok) return noExecutor;
  const absent = [
    ...(noRunner.value ? [`runner ${job.runnerId}`] : []),
    ...(noExecutor.value ? [`executor ${job.executor}`] : []),
  ];
  if (absent.length > 0) {
    return ok({
      rows: {},
      note: `the ${job.name} was not seeded (no ${absent.join(", no ")}): apply again once the supervisor has booted`,
      unseeded: `${job.setting ?? "this gate"} is on in this file, but the ${job.name}'s rows cannot be seeded yet (no ${absent.join(", no ")}). With the switch on and no kind='util' agent of the job, every gate of that kind fails no_reviewer and every ticket stops in code_review until an operator waives it. Boot the supervisor and apply this file again, or leave ${job.setting} out until then`,
    });
  }
  return ok({
    rows: await job.rows({ now, home }),
    note: `seeded the ${job.name} (${job.agentId})`,
  });
}

/** Whether the operator's own file declares a row of `id` in any table a job also seeds. */
const declares = (file: ConfigFile, id: string): boolean =>
  [...(file.agents ?? []), ...(file.profiles ?? [])].some(
    (r) => r["id"] === id,
  );

/** Every script job's plan: rows merged, notes in order, and the ones that would stall a gate. */
interface JobPlans {
  readonly rows: ConfigRows;
  /** What happened to each job, for the `applied:` line, in JOBS order. */
  readonly notes: readonly string[];
  /** The subset of those that are skips: a warning, and so stderr's. */
  readonly warnings: readonly string[];
  /** One line per job whose gate this file turns on while leaving the job unseeded. */
  readonly stalls: readonly string[];
}

async function jobPlans(
  db: Db,
  file: ConfigFile,
  home: string,
  now: number,
): Promise<Result<JobPlans>> {
  let rows: ConfigRows = {};
  const notes: string[] = [];
  const warnings: string[] = [];
  const stalls: string[] = [];
  for (const job of JOBS) {
    const plan = await jobPlan(db, job, file, home, now);
    if (!plan.ok) return plan;
    rows = merged(rows, plan.value.rows);
    if (plan.value.note !== "") notes.push(plan.value.note);
    if (plan.value.unseeded === undefined) continue;
    warnings.push(plan.value.note);
    // Only what this file itself switches on. A setting already true in the database is a fleet
    // that is already stalling, and refusing every later apply would leave no way to fix it.
    if (job.setting !== null && file.settings?.[job.setting] === true)
      stalls.push(plan.value.unseeded);
  }
  return ok({ rows, notes, warnings, stalls });
}

async function toConfigRows(
  file: ConfigFile,
  home: string,
  now: number,
): Promise<ConfigRows> {
  const rows = (list: readonly Row[] | undefined): Row[] =>
    (list ?? []).map(jsonColumns);
  const repos = rows(file.repos).map((r) => ({
    mirror_path: join(home, "mirrors", `${String(r["id"])}.git`),
    ...r,
  }));
  const profiles = await Promise.all(
    rows(file.profiles).map((r) => withProfileDefaults(r, now)),
  );
  const agents = rows(file.agents).map((r) => ({ created_at: now, ...r }));
  // ponytail: columns are checked by the database, not here; SQLite names an unknown or missing
  // column and a failed foreign key, and nothing is written. The cast only hands rows to it.
  return {
    repos,
    workspaces: rows(file.workspaces),
    workspace_repos: rows(file.workspace_repos),
    profiles,
    agents,
    run_classes: rows(file.run_classes),
    ...(file.settings === undefined ? {} : { settings: file.settings }),
  } as unknown as ConfigRows;
}

/**
 * The operator's rows with a script job's appended, table by table — and **never over one of
 * theirs**. §4 says config is the operator's: a row they wrote in this file wins over the shipped
 * default of the same key, in both directions it could lose.
 *
 *   - `profiles` and `agents` are inserted plainly, so a duplicate id is a `conflict` that writes
 *     nothing: their whole file lost to a row they never asked for.
 *   - `run_classes` is an upsert with the shipped row appended *last*, so an operator's own
 *     `{name:"lint", wall_clock_ms: …}` was silently overwritten by the default in the same
 *     command that wrote it.
 *
 * Keyed on what the table's conflict is keyed on: `id` for profiles and agents, `name` for run
 * classes.
 */
const append = <T>(
  own: readonly T[] | undefined,
  extra: readonly T[] | undefined,
  key: (row: T) => string,
): T[] => {
  const mine = new Set((own ?? []).map(key));
  return [
    ...(own ?? []),
    ...(extra ?? []).filter((row) => !mine.has(key(row))),
  ];
};

const merged = (file: ConfigRows, extra: ConfigRows): ConfigRows => ({
  ...file,
  profiles: append(file.profiles, extra.profiles, (r) => String(r.id)),
  agents: append(file.agents, extra.agents, (r) => String(r.id)),
  run_classes: append(file.run_classes, extra.run_classes, (r) =>
    String(r.name),
  ),
});

/** What the file asked for, for the `applied:` line. An empty object asked for nothing. */
const counted = (file: ConfigFile): string => {
  const parts = Object.entries(file).map(([table, v]) =>
    Array.isArray(v)
      ? `${String(v.length)} ${table}`
      : `${String(Object.keys(v).length)} ${table}`,
  );
  return parts.length === 0 ? "nothing" : parts.join(", ");
};

export interface ConfigIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function readConfigFile(path: string): Result<ConfigFile> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return invalid(
      `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success)
    return invalid(`${path}: ${z.prettifyError(parsed.error)}`);
  // Invariant 5: an agent's mission is the API's to set (POST /missions), never a config row's.
  if ((parsed.data.agents ?? []).some((a) => "mission_id" in a))
    return invalid(
      `${path}: agents.mission_id is set by the API (POST /missions), not here`,
    );
  const command = checkCommands(parsed.data);
  if (!command.ok) return invalid(`${path}: ${command.error.message}`);
  return ok(parsed.data);
}

/**
 * `repos.lint_cmd` and `repos.install_cmd` as the gate will read them (`lintArgv`, core).
 *
 * Fail fast at the boundary, like every other check here: without this the file applied with exit
 * 0 and `"lint_cmd": "eslint . && prettier --check ."` was found out the first time a `lint_check`
 * gate opened — as a `reviewer_error` on somebody's ticket, hours or weeks later. `lintArgv` is
 * pure, so the same rule that refuses it at job time refuses it here, with the same message naming
 * the fix. An absent or empty value is not a command and is left alone: a repo that declares none
 * simply opens no gate.
 */
function checkCommands(file: ConfigFile): Result<void> {
  for (const repo of file.repos ?? []) {
    for (const column of ["lint_cmd", "install_cmd"] as const) {
      const value = repo[column];
      if (typeof value !== "string" || value.trim() === "") continue;
      const argv = lintArgv(value);
      if (!argv.ok)
        return invalid(
          `repo ${String(repo["id"])}: ${argv.error.message.replace("repos.lint_cmd", `repos.${column}`)}`,
        );
    }
  }
  return ok(undefined);
}

/** Runs `frm config apply` or `frm models list`. */
export async function runConfigCommand(
  cmd: ConfigCommand,
  io: ConfigIo,
): Promise<number> {
  if (cmd.action === "models") return runModelsList(cmd.runner, io);
  const home = io.env["FRM_HOME"];
  if (home === undefined || home === "") {
    io.err("frm config apply: set FRM_HOME");
    return 2;
  }
  const file = readConfigFile(cmd.file);
  if (!file.ok) {
    io.err(`frm config apply: ${file.error.message}`);
    return 2;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const opened = await openDb({
    path: io.env["FRM_DB"] ?? join(home, "foreman.db"),
    clock: systemClock,
  });
  if (!opened.ok) {
    io.err(`frm config apply: ${opened.error.message}`);
    return 1;
  }
  const db = opened.value;
  try {
    const migrated = await migrateUp(db, {});
    if (!migrated.ok) {
      io.err(`frm config apply: nothing written: ${migrated.error.message}`);
      return 1;
    }
    const now = systemClock.now();
    const jobs = await jobPlans(db, file.value, home, now);
    if (!jobs.ok) {
      io.err(`frm config apply: nothing written: ${jobs.error.message}`);
      return 1;
    }
    // A file that turns a gate on while leaving that gate's job unseeded is refused outright
    // (review HIGH). It is the one combination this command can produce that no later command
    // fixes by itself: switch on, no kind='util' agent, so `chooseLintJob`/`chooseParityJob` answer
    // `no_reviewer` on every round and every ticket stops in `code_review`, decidable only by
    // waiving. The whole default-off design rests on "off is the safe state", and writing the
    // setting while skipping the rows inverted exactly that — silently, at exit 0.
    //
    // Refused rather than forced off or warned about, because the other three answers are worse:
    // seeding anyway is impossible (the profile and agent have foreign keys to a runner the
    // supervisor has not registered yet), forcing the switch off rewrites the operator's declared
    // config against §4, and warning-with-exit-1 leaves the fleet in the stalled state the warning
    // is about. Refusing writes nothing, which is what every other refusal in this command does,
    // and the fix is one line: boot the daemon, apply the same file again.
    if (jobs.value.stalls.length > 0) {
      for (const stall of jobs.value.stalls)
        io.err(`frm config apply: nothing written: ${stall}`);
      return 1;
    }
    const models = await planModels(db, file.value.models ?? [], io.env);
    if (!models.ok) {
      io.err(`frm config apply: nothing written: ${models.error.message}`);
      return 2;
    }
    // A provider URL directs network egress: shown, and written only with --yes.
    for (const change of models.value.settingsChanges) io.out(change);
    if (models.value.settingsChanges.length > 0 && !cmd.yes) {
      io.err(
        "frm config apply: nothing written: the file changes model settings (above: what each opens, and each lapses its model's certificate): repeat the command with --yes",
      );
      return 2;
    }
    // One transaction with the operator's own rows: either the whole apply lands or none of it.
    const seeded = await seedConfig(db, {
      ...merged(await toConfigRows(file.value, home, now), jobs.value.rows),
      models: models.value.rows,
    });
    if (!seeded.ok) {
      io.err(`frm config apply: nothing written: ${seeded.error.message}`);
      return 1;
    }
    // A skip is a warning, and a warning belongs on stderr: appended to the success line on stdout
    // it was invisible to anything reading exit codes or piping output (review HIGH).
    for (const warning of jobs.value.warnings)
      io.err(`frm config apply: warning: ${warning}`);
    io.out(
      `applied: ${counted(file.value)}${jobs.value.notes.map((n) => `; ${n}`).join("")}`,
    );
    return 0;
  } finally {
    await db.close();
  }
}
