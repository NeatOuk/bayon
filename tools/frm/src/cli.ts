import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { AGENT_USAGE, parseAgentCli, type AgentCommand } from "./agent-set.js";
import { BACKUP_USAGE, parseBackupCli, type BackupCommand } from "./backup.js";
import {
  CONFIG_USAGE,
  parseConfigCli,
  type ConfigCommand,
} from "./config-apply.js";
import {
  EXECUTOR_FLAGS,
  EXECUTOR_USAGE,
  parseExecutorCli,
  type ExecutorCommand,
} from "./executor.js";
import {
  FLEET_USAGE,
  parseFleetCli,
  type FleetCommand,
} from "./fleet-pause.js";
import { INIT_USAGE, parseInitCli, type InitCommand } from "./init.js";
import { START_USAGE } from "./start.js";
import {
  PROJECT_ADD_FLAGS,
  PROJECT_ADD_USAGE,
  parseProjectAddCli,
  type ProjectAddCommand,
} from "./project-add.js";
import {
  ROOTS_USAGE,
  ROOTS_USAGE_LINE,
  parseRootsCli,
  type RootsCommand,
} from "./roots.js";
import {
  CONFORMANCE_TIMEOUT_MS,
  ConformanceCliOptions,
} from "./runner-conformance.js";
import {
  SETTINGS_USAGE,
  parseSettingsCli,
  type SettingsCommand,
} from "./settings.js";
import { SMOKE_DEADLINE_MS } from "./smoke/budget.js";
import { closest } from "./suggest.js";

/** The supervisor's own executor (smoke/config.ts SMOKE.executor). */
const LOCAL_EXECUTOR = "local";

const secondsOf = (mode: keyof typeof SMOKE_DEADLINE_MS): string =>
  `${SMOKE_DEADLINE_MS[mode] / 1_000} s`;

const SMOKE_LINE =
  "frm smoke [--hang | --m1 | --m2 | --m3 | --m4] [--runner fixture|sdk] [--certify] [--timeout <seconds>] [--keep]";
const CONFORMANCE_LINE =
  "frm runner conformance <runner> [--model <id>] [--executor <id>] [--compression] [--out <dir>] [--timeout <seconds>]";

const SMOKE_USAGE = [
  `       ${SMOKE_LINE}`,
  "  --hang     the run never ends: expect a loud non-zero exit within the deadline",
  "  --m1       the M1 acceptance test: a session reads, updates and files tickets over MCP,",
  "             is refused a cross-ticket write, asks a human; then the markdown export",
  "  --m2       the M2 acceptance test: pulses staff one ticket through three hand-offs (turn",
  "             ceiling, handoff_request, a killed session) until it is blocked, then a skipped",
  "             pulse and two run-now calls that make one pulse; with --runner sdk, the real check",
  "  --m3       the M3 acceptance test: conformance certifies the builder's and the reviewer's",
  "             runners; plan_review, two code review rounds (a major finding, its fix), the QA",
  "             override, a timed-out review retried and a same-runner review, each gate with its",
  "             evidence. Fixture builder, the reviewer's stand-in CLI: no key, no network.",
  "             FRM_CONTAINER=1 … --m3 --executor <name>: the container run instead, on the shared",
  "             docker host (FRM_CONTAINER_HOST user@host, required;",
  "             FRM_CONTAINER_KEY): the executor registered and imaged as <name>-<hex>, the",
  "             reviewer's runner placed there (a ctr: ref, MCP through the tunnel, a canary secret,",
  "             egress), conformance and code review rounds on it; everything removed by label",
  "  --m4       the M4 acceptance test: pull the host's plug and lose only in-flight turns. A tiny",
  "             budget queues the next spawn until the cap is raised; the kill switch queues another",
  "             until resumed, the run in flight finishing either way; a backup is written and",
  "             restored; then every foreman process group is SIGKILLed at once and the fleet",
  "             restarted, twice, adopting what was resumable and re-admitting what was queued; last",
  "             the sweep removes the clean worktrees and keeps the dirty one",
  "  --runner   fixture (default), or sdk: a real model; needs FRM_REAL_RUNNER=1 and its key",
  "  --certify  with --runner sdk: certify the real runner on local first (the conformance suite,",
  "             real spend); without it the smoke lets uncertified runners run, and says so loudly",
  `  --timeout  the whole smoke's deadline (default ${secondsOf("normal")}, ` +
    `${secondsOf("hang")} with --hang, ${secondsOf("m1")} with --m1, ${secondsOf("m2")} with --m2, ` +
    `${secondsOf("m3")} with --m3, ${secondsOf("m3Container")} for its container run, ` +
    `${secondsOf("m4")} with --m4)`,
  "  --keep     keep the temp FRM_HOME even when the smoke passes",
].join("\n");

const CONFORMANCE_USAGE = [
  `       ${CONFORMANCE_LINE}`,
  "             certifies (runner, executor, model); without --model, every model in use (a role",
  "             binding, a project step tier or an enabled agent), else the runner's default (standard tier)",
  "runner conformance: the running supervisor runs the conformance suite for <runner> on an executor, asked",
  "  through this home's API (FRM_API_URL, else its install.json port; FRM_API_TOKEN, else its stored token); frm waits and",
  "  prints the report path and the verdict. Exit 0 only if the pair is certified with no failed test.",
  "  --executor the executor to certify on (default local); a disabled one is refused: enable it",
  "             first with `frm executor enable <name>`",
  "  --compression  with context compression on: test 17 as well, and the certificate a project",
  "             that compresses its context needs (a local executor, a runner that compresses)",
  "  --out      the report's directory (default <FRM_HOME>/conformance on the supervisor's host)",
  `  --timeout  how long to wait (default ${CONFORMANCE_TIMEOUT_MS / 1_000} s)`,
].join("\n");

/** A top-level command: its one-line summary, its synopsis, its options and its usage block. */
export interface CommandInfo {
  readonly summary: string;
  readonly line: string;
  /** Long options without the leading `--`, as its parser reads them. */
  readonly options: readonly string[];
  readonly usage: string;
  /** Option prefixes its parser refuses by name, with a reason better than "unknown option". */
  readonly refused?: readonly string[];
}

const SMOKE_OPTIONS = [
  "hang",
  "m1",
  "m2",
  "m3",
  "m4",
  "runner",
  "certify",
  "timeout",
  "keep",
  "executor",
];
const CONFIG_LINE =
  "frm config apply <file.json> [--yes] | frm models list [runner]";
const BACKUP_LINE =
  "frm backup | frm backup init-key [--rotate] | frm restore <file> --to <db-path> [--replace]";
const BACKUP_OPTIONS = ["rotate", "replace", "to"];

/** Every top-level command, in the order the short list shows them. */
export const COMMANDS: Readonly<Record<string, CommandInfo>> = {
  init: {
    summary: "make this home an install: its own API token and ports",
    line: "frm init [--api-port <n>] [--web-port <n>]",
    options: ["api-port", "web-port"],
    usage: INIT_USAGE.join("\n"),
  },
  start: {
    summary: "run the supervisor, the API and the GUI; Ctrl-C stops them",
    line: "frm start",
    options: [],
    usage: START_USAGE.join("\n"),
  },
  smoke: {
    summary: "the acceptance tests (M0, --m1 … --m4)",
    line: SMOKE_LINE,
    options: SMOKE_OPTIONS,
    usage: SMOKE_USAGE,
  },
  runner: {
    summary: "conformance <runner>: certify a runner on an executor",
    line: CONFORMANCE_LINE,
    options: ["executor", "model", "compression", "out", "timeout"],
    usage: CONFORMANCE_USAGE,
  },
  project: {
    summary: "add <name>: everything one project needs",
    line: "frm project add <name> --repo <url|path> --runner <id> [flags]",
    options: Object.keys(PROJECT_ADD_FLAGS),
    usage: PROJECT_ADD_USAGE,
  },
  roots: {
    summary: "list | add | remove <path>: folders the New project form may use",
    line: ROOTS_USAGE_LINE,
    options: ["yes"],
    usage: ROOTS_USAGE,
  },
  settings: {
    summary: "get [key] | set <key> <value>: the governed settings",
    line: "frm settings get [key] | frm settings set <key> <value> [--yes]",
    options: ["yes"],
    usage: SETTINGS_USAGE,
  },
  agent: {
    summary: "set <id>: an agent's profile, enabled, max concurrency",
    line: "frm agent set <id> [--profile <id>] [--enabled true|false] [--max-concurrency <n>]",
    options: ["profile", "enabled", "max-concurrency"],
    usage: AGENT_USAGE,
    refused: ["--mission"],
  },
  executor: {
    summary: "add | image | disable | enable <id>: container executors",
    line: "frm executor add <id> --host <host> … | frm executor image <id> | frm executor disable|enable <id>",
    options: Object.keys(EXECUTOR_FLAGS),
    usage: EXECUTOR_USAGE,
  },
  config: {
    summary: "apply <file.json>: rows and settings from a file",
    line: CONFIG_LINE,
    options: ["yes"],
    usage: CONFIG_USAGE,
  },
  models: {
    summary: "list [runner]: the models each runner serves",
    line: CONFIG_LINE,
    options: [],
    usage: CONFIG_USAGE,
  },
  pause: {
    summary: "hold the whole fleet (the kill switch)",
    line: "frm pause | frm resume",
    options: [],
    usage: FLEET_USAGE,
  },
  resume: {
    summary: "lift a pause",
    line: "frm pause | frm resume",
    options: [],
    usage: FLEET_USAGE,
  },
  backup: {
    summary: "an encrypted backup now; init-key",
    line: BACKUP_LINE,
    options: BACKUP_OPTIONS,
    usage: BACKUP_USAGE,
  },
  restore: {
    summary: "<file> --to <db-path>: restore a backup",
    line: BACKUP_LINE,
    options: BACKUP_OPTIONS,
    usage: BACKUP_USAGE,
  },
};

const HELP_HINT = "frm --help for the full usage";

/** The commands, one line each: what an unknown command is answered with. */
const COMMAND_LIST = [
  "commands:",
  ...Object.entries(COMMANDS).map(
    ([word, c]) => `  ${word.padEnd(10)}${c.summary}`,
  ),
].join("\n");

export const USAGE = [
  "usage: frm <command> …   FRM_HOME defaults to ~/.foreman when neither FRM_HOME nor FRM_DB is set",
  COMMAND_LIST,
  "",
  SMOKE_USAGE,
  CONFORMANCE_USAGE,
  PROJECT_ADD_USAGE,
  ROOTS_USAGE,
  EXECUTOR_USAGE,
  BACKUP_USAGE,
  FLEET_USAGE,
  CONFIG_USAGE,
  AGENT_USAGE,
  SETTINGS_USAGE,
  ...INIT_USAGE,
  ...START_USAGE,
].join("\n");

/** What main prints for a parse error: a command's own reason gets the prefix and one pointer. */
export function cliErrorText(message: string): string {
  return message.startsWith("frm") ? message : `frm: ${message}\n${HELP_HINT}`;
}

/** Which smoke: M0's (`normal`), M0's hang, or a milestone's acceptance test. */
export const SmokeMode = z.enum(["normal", "hang", "m1", "m2", "m3", "m4"]);
export type SmokeMode = z.infer<typeof SmokeMode>;

const SmokeOptions = z
  .object({
    mode: SmokeMode,
    runner: z.enum(["fixture", "sdk"]),
    timeoutMs: z.int().positive(),
    keep: z.boolean(),
    /** --runner sdk only: certify the real runner (§15) instead of require_certified=0. */
    certify: z.boolean(),
    /** --m3 only: the executor its review rounds run on (a container waits for). */
    executor: z.string().min(1).optional(),
  })
  .refine((o) => !(o.certify && o.runner === "fixture"), {
    message:
      "--certify certifies a real runner; the fixture runner is always certified: use it with --runner sdk",
  })
  .refine((o) => !(o.mode === "hang" && o.runner === "sdk"), {
    message: "--hang uses the fixture runner's hang script: drop --runner sdk",
  })
  .refine((o) => !(o.mode === "m1" && o.runner === "sdk"), {
    message:
      "--m1 drives its MCP calls from the fixture runner's script: drop --runner sdk",
  })
  .refine((o) => !(o.mode === "m3" && o.runner === "sdk"), {
    message:
      "--m3 runs the fixture builder and the reviewer's stand-in CLI; its real checks (a real " +
      "reviewer's conformance and review) wait for the owner's credential: drop --runner sdk",
  });
export type SmokeOptions = z.infer<typeof SmokeOptions>;

export type Cli =
  | { readonly command: "help"; readonly topic?: string }
  | { readonly command: "smoke"; readonly options: SmokeOptions }
  | {
      readonly command: "runner-conformance";
      readonly options: ConformanceCliOptions;
    }
  | { readonly command: "executor"; readonly options: ExecutorCommand }
  | { readonly command: "backup"; readonly options: BackupCommand }
  | { readonly command: "fleet"; readonly options: FleetCommand }
  | { readonly command: "config"; readonly options: ConfigCommand }
  | { readonly command: "agent"; readonly options: AgentCommand }
  | { readonly command: "settings"; readonly options: SettingsCommand }
  | { readonly command: "roots"; readonly options: RootsCommand }
  | { readonly command: "project"; readonly options: ProjectAddCommand }
  | { readonly command: "init"; readonly options: InitCommand }
  | { readonly command: "start" };

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** The flags that each pick a smoke other than M0's; at most one may be given. */
const MODE_FLAGS = ["hang", "m1", "m2", "m3", "m4"] as const;
type ModeFlag = (typeof MODE_FLAGS)[number];

/** Every flag, as parseArgs reads them. */
interface Flags extends Readonly<Record<ModeFlag, boolean>> {
  readonly keep: boolean;
  readonly certify: boolean;
  readonly runner?: string | undefined;
  readonly timeout?: string | undefined;
  readonly executor?: string | undefined;
  readonly out?: string | undefined;
  readonly model?: string | undefined;
  readonly compression: boolean;
}

function modeOf(flags: Readonly<Record<ModeFlag, boolean>>): Result<SmokeMode> {
  const given = MODE_FLAGS.filter((flag) => flags[flag]);
  if (given.length > 1)
    return invalid(
      `${given.map((flag) => `--${flag}`).join(" and ")} are separate smokes: pick one`,
    );
  return ok(given[0] ?? "normal");
}

function readArgs(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          hang: { type: "boolean", default: false },
          m1: { type: "boolean", default: false },
          m2: { type: "boolean", default: false },
          m3: { type: "boolean", default: false },
          m4: { type: "boolean", default: false },
          runner: { type: "string" },
          timeout: { type: "string" },
          keep: { type: "boolean", default: false },
          certify: { type: "boolean", default: false },
          executor: { type: "string" },
          out: { type: "string" },
          model: { type: "string" },
          compression: { type: "boolean", default: false },
          help: { type: "boolean", short: "h", default: false },
        },
      }),
    );
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "bad arguments");
  }
}

function smokeCli(flags: Flags): Result<Cli> {
  if (
    flags.out !== undefined ||
    flags.model !== undefined ||
    flags.compression ||
    (flags.executor !== undefined && !flags.m3)
  )
    return invalid(
      "--out, --model and --compression belong to frm runner conformance; --executor to frm runner conformance and frm smoke --m3",
    );
  const mode = modeOf(flags);
  if (!mode.ok) return mode;
  // A named executor other than the local one is --m3's container run: its own, longer deadline.
  const container =
    mode.value === "m3" &&
    flags.executor !== undefined &&
    flags.executor !== LOCAL_EXECUTOR;
  const timeoutMs =
    flags.timeout !== undefined
      ? Number(flags.timeout) * 1_000
      : SMOKE_DEADLINE_MS[container ? "m3Container" : mode.value];
  const options = SmokeOptions.safeParse({
    mode: mode.value,
    runner: flags.runner ?? "fixture",
    timeoutMs,
    keep: flags.keep,
    certify: flags.certify,
    ...(flags.executor === undefined ? {} : { executor: flags.executor }),
  });
  return options.success
    ? ok({ command: "smoke", options: options.data })
    : invalid(z.prettifyError(options.error));
}

/** `frm runner conformance <runner>`: `--out` is made absolute here, against frm's own cwd. */
function runnerCli(flags: Flags, rest: readonly string[]): Result<Cli> {
  const [sub, runnerId, ...more] = rest;
  if (sub !== "conformance" || runnerId === undefined || more.length > 0)
    return invalid(
      `unknown command: runner ${rest.join(" ")}; usage: frm runner conformance <runner>`,
    );
  const smokeOnly = [
    ...MODE_FLAGS.filter((flag) => flags[flag]),
    ...(flags.keep ? ["keep"] : []),
    ...(flags.certify ? ["certify"] : []),
    ...(flags.runner === undefined ? [] : ["runner"]),
  ];
  if (smokeOnly.length > 0)
    return invalid(
      `${smokeOnly.map((flag) => `--${flag}`).join(" and ")} belong to frm smoke`,
    );
  const options = ConformanceCliOptions.safeParse({
    runnerId,
    executorId: flags.executor ?? "local",
    ...(flags.model === undefined ? {} : { modelId: flags.model }),
    compression: flags.compression,
    ...(flags.out === undefined ? {} : { outDir: resolve(flags.out) }),
    timeoutMs:
      flags.timeout === undefined
        ? CONFORMANCE_TIMEOUT_MS
        : Number(flags.timeout) * 1_000,
  });
  return options.success
    ? ok({ command: "runner-conformance", options: options.data })
    : invalid(z.prettifyError(options.error));
}

/** The long options in `argv` (up to a `--`), as typed, without any `=value`. */
function longOptions(argv: readonly string[]): string[] {
  const end = argv.indexOf("--");
  return (end === -1 ? argv : argv.slice(0, end))
    .filter((a) => a.startsWith("--") && a.length > 2)
    .map((a) => a.split("=")[0] ?? a);
}

const wantsHelp = (argv: readonly string[]): boolean => {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  return head.includes("--help") || head.includes("-h");
};

function unknownCommand(word: string): Result<never> {
  const near = closest(word, Object.keys(COMMANDS));
  return invalid(
    [
      `frm: unknown command ${JSON.stringify(word)}.${near === null ? "" : ` Did you mean ${JSON.stringify(near)}?`}`,
      COMMAND_LIST,
      HELP_HINT,
    ].join("\n"),
  );
}

/** The first option `word` does not take, named with the closest it does, or null when all are known. */
function unknownOption(
  word: string,
  argv: readonly string[],
  reason: string,
): string | null {
  const command = COMMANDS[word];
  if (command === undefined) return null;
  const known = command.options.map((o) => `--${o}`);
  // A reason that already names the option ("--certify belong to frm smoke") says it better.
  const pointed = (o: string): boolean =>
    reason.includes(o) && !reason.includes("Unknown option");
  const bad = longOptions(argv).find(
    (o) =>
      !known.includes(o) &&
      !pointed(o) &&
      !(command.refused ?? []).some((r) => o.startsWith(r)),
  );
  if (bad === undefined) return null;
  // Matched without the dashes, which would otherwise count toward the typo's length.
  const bare = closest(bad.slice(2), command.options);
  const near = bare === null ? null : `--${bare}`;
  return [
    `frm ${word}: unknown option ${JSON.stringify(bad)}.${near === null ? "" : ` Did you mean ${JSON.stringify(near)}?`}`,
    known.length === 0
      ? `frm ${word} takes no options`
      : `frm ${word} options: ${known.join(" ")}`,
    `usage: ${command.line}`,
    `frm ${word} --help for more`,
  ].join("\n");
}

/** `frm <command> [flags]`: the command, or a validation error carrying the reason. */
export function parseCli(argv: readonly string[]): Result<Cli> {
  const [word] = argv;
  if (word === undefined || word === "help") return ok({ command: "help" });
  // Options before any command word are the smoke's (`frm --m1 smoke`): its own parser reads them.
  if (word.startsWith("-")) return parseCommand(argv);
  if (!Object.hasOwn(COMMANDS, word)) return unknownCommand(word);
  if (wantsHelp(argv)) return ok({ command: "help", topic: word });
  const parsed = parseCommand(argv);
  if (parsed.ok) return parsed;
  // The command's own parser refused it: an option it does not take is named plainly, with the
  // ones it does, instead of parseArgs' text; any other reason is the parser's own.
  const option = unknownOption(word, argv, parsed.error.message);
  return option === null ? parsed : invalid(option);
}

function parseCommand(argv: readonly string[]): Result<Cli> {
  if (argv[0] === "executor") {
    const executor = parseExecutorCli(argv.slice(1));
    return executor.ok
      ? ok({ command: "executor", options: executor.value })
      : executor;
  }
  if (argv[0] === "pause" || argv[0] === "resume") {
    const fleet = parseFleetCli(argv);
    return fleet.ok ? ok({ command: "fleet", options: fleet.value }) : fleet;
  }
  if (argv[0] === "config" || argv[0] === "models") {
    const config = parseConfigCli(argv);
    return config.ok
      ? ok({ command: "config", options: config.value })
      : config;
  }
  if (argv[0] === "settings") {
    const settings = parseSettingsCli(argv);
    return settings.ok
      ? ok({ command: "settings", options: settings.value })
      : settings;
  }
  if (argv[0] === "roots") {
    const roots = parseRootsCli(argv);
    return roots.ok ? ok({ command: "roots", options: roots.value }) : roots;
  }
  if (argv[0] === "agent") {
    const agent = parseAgentCli(argv);
    return agent.ok ? ok({ command: "agent", options: agent.value }) : agent;
  }
  if (argv[0] === "project") {
    const project = parseProjectAddCli(argv);
    return project.ok
      ? ok({ command: "project", options: project.value })
      : project;
  }
  if (argv[0] === "start") {
    return argv.length === 1
      ? ok({ command: "start" })
      : invalid(`frm start takes no arguments: ${argv.slice(1).join(" ")}`);
  }
  if (argv[0] === "init") {
    const init = parseInitCli(argv);
    return init.ok ? ok({ command: "init", options: init.value }) : init;
  }
  if (argv[0] === "backup" || argv[0] === "restore") {
    const backup = parseBackupCli(argv);
    return backup.ok
      ? ok({ command: "backup", options: backup.value })
      : backup;
  }
  const args = readArgs(argv);
  if (!args.ok) return args;
  const { values, positionals } = args.value;
  if (values.help || positionals.length === 0) return ok({ command: "help" });
  if (positionals[0] === "runner")
    return runnerCli(values, positionals.slice(1));
  if (positionals[0] !== "smoke" || positionals.length > 1)
    return invalid(`unknown command: ${positionals.join(" ")}`);
  return smokeCli(values);
}
