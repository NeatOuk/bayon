import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  err,
  ok,
  systemClock,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import { openDb } from "./connection.js";
import { capture, failure } from "./errors.js";
import {
  migrateDown,
  migrateUp,
  migrationStatus,
  migrationTag,
  type MigrationStatus,
} from "./migrate.js";

const USAGE = [
  "usage: migrate <up|down|status> [--db <file>] [--to <version>] [--yes]",
  "  --db   the database file; else $FRM_DB, else $FRM_HOME/foreman.db",
  "  --to   up only: stop after this version",
  "  --yes  down only: confirm reverting the latest migration (001's drops every table)",
].join("\n");

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const Args = z
  .object({
    command: z.enum(["up", "down", "status"]),
    db: z
      .string({ error: "no database: pass --db, or set FRM_DB or FRM_HOME" })
      .min(1),
    to: z.coerce.number().int().nonnegative().optional(),
    yes: z.boolean(),
  })
  .refine((a) => a.command !== "down" || a.yes, {
    message: "down reverts the latest migration and can drop data: pass --yes",
  })
  .refine((a) => a.to === undefined || a.command === "up", {
    message: "--to applies to up only",
  });
type Args = z.infer<typeof Args>;

function parse(argv: readonly string[], env: CliIo["env"]): Result<Args> {
  const parsed = capture(() =>
    parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        db: { type: "string" },
        to: { type: "string" },
        yes: { type: "boolean", default: false },
      },
    }),
  );
  if (!parsed.ok) return err(failure("validation", parsed.error.message));
  const { values, positionals } = parsed.value;
  if (positionals.length !== 1) {
    return err(
      failure("validation", `expected one command, got ${positionals.length}`),
    );
  }
  const home = env.FRM_HOME;
  const args = Args.safeParse({
    command: positionals[0],
    db:
      values.db ??
      env.FRM_DB ??
      (home === undefined ? undefined : join(home, "foreman.db")),
    to: values.to,
    yes: values.yes,
  });
  return args.success
    ? ok(args.data)
    : err(failure("validation", z.prettifyError(args.error)));
}

const list = (items: readonly string[]) =>
  items.length === 0 ? "(none)" : items.join(", ");

function format(path: string, s: MigrationStatus): string {
  const applied = s.applied.map(
    (m) =>
      `${migrationTag(m)}  sha256 ${m.checksum.slice(0, 12)}  ${new Date(m.appliedAt).toISOString()}`,
  );
  return [
    `database  ${path}`,
    `applied   ${applied.length === 0 ? "(none)" : applied.join("\n          ")}`,
    `pending   ${list(s.pending.map(migrationTag))}`,
    `drifted   ${list(s.drifted.map(migrationTag))}`,
    `tables    ${s.tables.length}: ${s.tables.join(", ")}`,
    `views     ${s.views.length}: ${s.views.join(", ")}`,
  ].join("\n");
}

const describe = (e: FrmError) => `${e.class}: ${e.message}`;

/** The migrate CLI. Exit codes: 0 done, 1 the command failed, 2 bad arguments. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  const args = parse(argv, io.env);
  if (!args.ok) {
    io.err(`${args.error.message}\n${USAGE}`);
    return 2;
  }
  const { command, db: path, to } = args.value;
  const opened = await openDb({ path, clock: io.clock });
  if (!opened.ok) {
    io.err(describe(opened.error));
    return 1;
  }
  const db = opened.value;
  const result =
    command === "up"
      ? await migrateUp(db, { to })
      : command === "down"
        ? await migrateDown(db)
        : await migrationStatus(db);
  await db.close();
  if (!result.ok) {
    io.err(describe(result.error));
    return 1;
  }
  io.out(format(path, result.value));
  return 0;
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    clock: systemClock,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  });
}
