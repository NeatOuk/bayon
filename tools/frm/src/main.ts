import { systemClock } from "@bayon/core";
import { runAgentCommand } from "./agent-set.js";
import { runBackupCommand } from "./backup.js";
import { USAGE, parseCli } from "./cli.js";
import { runConfigCommand } from "./config-apply.js";
import { runExecutorCommand } from "./executor.js";
import { runFleetCommand } from "./fleet-pause.js";
import { runProjectAddCommand } from "./project-add.js";
import { runnerConformance } from "./runner-conformance.js";
import { runSettingsCommand } from "./settings.js";
import { within } from "./smoke/deadline.js";
import { reapAll } from "./smoke/procs.js";
import { runSmoke } from "./smoke/run.js";

// `pnpm frm <command>`. Exit codes: 0 passed, 1 a check failed, 2 bad usage or the overall
// deadline passed, 130 interrupted. Every child process group is killed on the way out.

const exit = (code: number): void => {
  // Flush first: stdout may be a pipe (CI), where writes are asynchronous.
  process.stdout.write("", () => process.exit(code));
};

const cli = parseCli(process.argv.slice(2));
if (!cli.ok) {
  console.error(`frm: ${cli.error.message}\n${USAGE}`);
  exit(2);
} else if (cli.value.command === "help") {
  console.log(USAGE);
  exit(0);
} else if (cli.value.command === "executor") {
  exit(
    await runExecutorCommand(cli.value.options, {
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "fleet") {
  exit(
    await runFleetCommand(cli.value.options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "config") {
  exit(
    await runConfigCommand(cli.value.options, {
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "agent") {
  exit(
    await runAgentCommand(cli.value.options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "settings") {
  exit(
    await runSettingsCommand(cli.value.options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "project") {
  exit(
    await runProjectAddCommand(cli.value.options, {
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "backup") {
  exit(
    await runBackupCommand(cli.value.options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    }),
  );
} else if (cli.value.command === "runner-conformance") {
  exit(
    await runnerConformance(cli.value.options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
    }),
  );
} else {
  const { options } = cli.value;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      reapAll();
      exit(130);
    });
  const finished = await within(
    { clock: systemClock, timeoutMs: options.timeoutMs, what: "frm smoke" },
    runSmoke(options, {
      env: process.env,
      clock: systemClock,
      out: (line) => console.log(line),
    }),
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
