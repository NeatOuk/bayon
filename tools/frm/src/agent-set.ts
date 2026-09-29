// `frm agent set <id>`: edits an agent already in the database (its profile, enabled,
// max_concurrency) so a broken one can be repaired or retired. Straight into $FRM_DB (else
// $FRM_HOME/foreman.db) through @bayon/db/operator, audited as the operator's with via 'frm' in the
// write's own transaction. Never mission_id: the API sets it (POST /missions).
// Exit codes: 0 set (or already so), 1 refused by the database, 2 bad usage or no database.
import { parseArgs } from "node:util";
import { err, ok, type Clock, type Result } from "@bayon/core";
import { openDb } from "@bayon/db";
import {
  setAgentFromCli,
  type AgentChange,
  type AgentFields,
  type AgentPatch,
} from "@bayon/db/operator";
import { dbPathOf } from "./db-path.js";

const USAGE_LINE =
  "frm agent set <id> [--profile <id>] [--enabled true|false] [--max-concurrency <n>]";

export const AGENT_USAGE = [
  `       ${USAGE_LINE}`,
  "agent set: edits an agent in $FRM_DB (else $FRM_HOME/foreman.db): its profile (one for the",
  "  agent's runner), enabled, max_concurrency. At least one flag. --enabled false or",
  "  --max-concurrency 0 retires it: admission refuses its spawns (disabled) and ends any it has",
  "  queued. Audited as the operator's (via frm); the supervisor reads it at the agent's next",
  "  spawn. Never mission_id: the API sets it (POST /missions).",
].join("\n");

export interface AgentCommand {
  readonly id: string;
  readonly patch: AgentPatch;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const COUNT = /^(?:0|[1-9]\d*)$/;

interface AgentFlags {
  readonly profile?: string | undefined;
  readonly enabled?: string | undefined;
  readonly "max-concurrency"?: string | undefined;
}

function readArgs(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: {
          profile: { type: "string" },
          enabled: { type: "string" },
          "max-concurrency": { type: "string" },
        },
      }),
    );
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : "bad arguments";
    return invalid(`${why}; usage: ${USAGE_LINE}`);
  }
}

function patchOf(flags: AgentFlags): Result<AgentPatch> {
  const { profile, enabled, "max-concurrency": max } = flags;
  if (profile === "") return invalid("--profile takes a profile id");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    return invalid(
      `--enabled takes true or false, not ${JSON.stringify(enabled)}`,
    );
  }
  if (
    max !== undefined &&
    !(COUNT.test(max) && Number.isSafeInteger(Number(max)))
  ) {
    return invalid(
      `--max-concurrency takes a whole number, 0 or more, not ${JSON.stringify(max)}`,
    );
  }
  const patch: AgentPatch = {
    ...(profile === undefined ? {} : { profile_id: profile }),
    ...(enabled === undefined ? {} : { enabled: enabled === "true" }),
    ...(max === undefined ? {} : { max_concurrency: Number(max) }),
  };
  return Object.keys(patch).length > 0
    ? ok(patch)
    : invalid(
        `name at least one of --profile, --enabled, --max-concurrency; usage: ${USAGE_LINE}`,
      );
}

/** `frm agent set <id> …`: argv from the command word on. */
export function parseAgentCli(argv: readonly string[]): Result<AgentCommand> {
  // Refused by name, before parseArgs calls it an unknown option: an agent's mission is the API's.
  if (argv.some((a) => a.startsWith("--mission"))) {
    return invalid(
      "agents.mission_id is set by the API (POST /missions), not by frm",
    );
  }
  const args = readArgs(argv);
  if (!args.ok) return args;
  const [word, action, id, ...rest] = args.value.positionals;
  if (
    word !== "agent" ||
    action !== "set" ||
    id === undefined ||
    rest.length > 0
  ) {
    return invalid(`usage: ${USAGE_LINE}`);
  }
  const patch = patchOf(args.value.values);
  return patch.ok ? ok({ id, patch: patch.value }) : patch;
}

export interface AgentIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const FIELDS: readonly (keyof AgentFields)[] = [
  "profile_id",
  "enabled",
  "max_concurrency",
];
const shown = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "none" : String(v);

function said(c: AgentChange): string {
  if (!c.changed) return `agent ${c.id}: already so; nothing written`;
  const moves = FIELDS.filter((f) => f in c.to).map(
    (f) => `${f} ${shown(c.from[f])} -> ${shown(c.to[f])}`,
  );
  return `agent ${c.id}: ${moves.join(", ")} (audited: agent.set via frm)`;
}

/** Runs `frm agent set`. */
export async function runAgentCommand(
  cmd: AgentCommand,
  io: AgentIo,
): Promise<number> {
  const path = dbPathOf(io.env, "the database the agent is in");
  if (!path.ok) {
    io.err(`frm agent set: ${path.error.message}`);
    return 2;
  }
  const opened = await openDb({ path: path.value, clock: io.clock });
  if (!opened.ok) {
    io.err(`frm agent set: ${opened.error.message}`);
    return 1;
  }
  try {
    const set = await setAgentFromCli(opened.value, cmd.id, cmd.patch);
    if (!set.ok) {
      io.err(`frm agent set: nothing written: ${set.error.message}`);
      return 1;
    }
    io.out(said(set.value));
    return 0;
  } finally {
    await opened.value.close();
  }
}
