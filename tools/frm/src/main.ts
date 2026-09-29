import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock } from "@bayon/core";
import { runAgentCommand } from "./agent-set.js";
import { runBackupCommand } from "./backup.js";
import { COMMANDS, USAGE, cliErrorText, parseCli, type Cli } from "./cli.js";
import { runConfigCommand } from "./config-apply.js";
import { runExecutorCommand } from "./executor.js";
import { apiEnvOf } from "./api-access.js";
import { runFleetCommand } from "./fleet-pause.js";
import { runInitCommand } from "./init.js";
import { NO_DEFAULT_HOME_ENV, homeEnvOf, shownHome } from "./home.js";
import { runProjectAddCommand } from "./project-add.js";
import { operatorCwd, runRootsCommand } from "./roots.js";
import { runnerConformance } from "./runner-conformance.js";
import { runSettingsCommand } from "./settings.js";
import { runStartCommand } from "./start.js";
import { within } from "./smoke/deadline.js";
import { reapAll } from "./smoke/procs.js";
import { runSmoke } from "./smoke/run.js";
import { staleBuildNotice } from "./stale-build.js";

// `pnpm frm <command>`. Exit codes: 0 passed, 1 a check failed, 2 bad usage or the overall
// deadline passed, 130 interrupted. Every child process group is killed on the way out.

const exit = (code: number): void => {
  // Flush first: stdout may be a pipe (CI), where writes are asynchronous.
  process.stdout.write("", () => process.exit(code));
};

const out = (line: string): void => console.log(line);
const errLine = (line: string): void => console.error(line);

/** The commands that open a database, and so run on a home: ~/.foreman unless the env names one. */
type HomeCommand = Exclude<
  Cli,
  { command: "help" | "smoke" | "runner-conformance" }
>;

async function runOnHome(cli: HomeCommand): Promise<number> {
  // A pause goes to the API first: a home is resolved only if it falls back to the database.
  if (cli.command === "fleet")
    return runFleetCommand(cli.options, {
      env: process.env,
      clock: systemClock,
      out,
      err: errLine,
      home: () => homeEnvOf(process.env),
    });
  const home = homeEnvOf(process.env);
  if (!home.ok) {
    errLine(`frm: ${home.error.message}`);
    return 2;
  }
  if (home.value.defaulted !== null)
    errLine(`(using ${shownHome(home.value.defaulted)})`);
  const env = home.value.env;
  const io = { env, clock: systemClock, out, err: errLine };
  switch (cli.command) {
    case "executor":
      return runExecutorCommand(cli.options, io);
    case "config":
      return runConfigCommand(cli.options, io);
    case "agent":
      return runAgentCommand(cli.options, io);
    case "settings":
      return runSettingsCommand(cli.options, io);
    case "roots":
      // Under `pnpm frm` the process runs in the repo root; a relative path is the operator's.
      return runRootsCommand(cli.options, {
        ...io,
        cwd: operatorCwd(env),
      });
    case "project":
      return runProjectAddCommand(cli.options, io);
    case "backup":
      return runBackupCommand(cli.options, io);
    case "init":
      return runInitCommand(cli.options, io);
    case "start":
      // After a hang-up the terminal is gone: a write to it must not end frm mid-stop.
      for (const stream of [process.stdout, process.stderr])
        stream.on("error", () => {});
      return runStartCommand(io);
  }
}

async function smoke(
  options: Extract<Cli, { command: "smoke" }>["options"],
): Promise<void> {
  // The smoke makes its own temp home and names it to every child; nothing it starts may fall back
  // to the operator's ~/.foreman.
  process.env[NO_DEFAULT_HOME_ENV] = "1";
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      reapAll();
      exit(130);
    });
  const finished = await within(
    { clock: systemClock, timeoutMs: options.timeoutMs, what: "frm smoke" },
    runSmoke(options, { env: process.env, clock: systemClock, out }),
  );
  if (finished.ok) exit(finished.value);
  else {
    console.log(
      `FAIL  ${finished.error.message}: the overall deadline passed; killing every child process`,
    );
    reapAll();
    exit(2);
  }
}

const stale = staleBuildNotice(dirname(fileURLToPath(import.meta.url)));
if (stale !== null) errLine(stale);

const cli = parseCli(process.argv.slice(2));
if (!cli.ok) {
  errLine(cliErrorText(cli.error.message));
  exit(2);
} else if (cli.value.command === "help") {
  const topic =
    cli.value.topic === undefined ? undefined : COMMANDS[cli.value.topic];
  out(topic === undefined ? USAGE : `usage: ${topic.usage.trimStart()}`);
  exit(0);
} else if (cli.value.command === "runner-conformance") {
  // This home's API and bearer: the env's, else the default home's (FRM_HOME set by homeEnvOf).
  exit(
    await runnerConformance(cli.value.options, {
      env: apiEnvOf(process.env, () => homeEnvOf(process.env)),
      clock: systemClock,
      out,
    }),
  );
} else if (cli.value.command === "smoke") {
  await smoke(cli.value.options);
} else {
  exit(await runOnHome(cli.value));
}
