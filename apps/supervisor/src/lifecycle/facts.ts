// A hand-off's generated half (§7.2): git, events and counters, never model
// output. Git runs through the executor on the session's worktree; a git failure never blocks,
// it is said in the facts.
import {
  DEFAULT_TICKET_KEY_PREFIX,
  HandoffFacts,
  TicketKeyPrefix,
  err,
  ok,
  ticketKey,
  type CommandFact,
  type HandoffFile,
  type RepoFacts,
  type Result,
} from "@bayon/core";
import {
  getSessionEventRange,
  getSettings,
  getTicket,
  getTicketEconomics,
  listSessionCommands,
  listSessionWorktrees,
  listTicketFindings,
  listTicketGates,
  listTicketHumanRequests,
  type EventRange,
  type EventRow,
  type SessionRow,
  type WorktreeRow,
} from "@bayon/db";
import { safeGitArgs, type Executor } from "@bayon/executors";
import { z } from "zod";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { exitedOk, runArgv } from "./exec.js";
import { publishSubmodules } from "./publish-submodules.js";
import { findRunClass } from "./resolve.js";

/** Where a session's packets go: its worktree, on its executor. */
export interface PacketPlace {
  readonly executor: Executor;
  readonly dir: string;
}

export interface Gathered {
  readonly facts: HandoffFacts;
  readonly place?: PacketPlace;
}

const COMMANDS_READ = 200;
const COMMANDS_KEPT = 8;
const QUESTIONS_READ = 50;
const QUESTIONS_KEPT = 3;
const QUESTION_CHARS = 80;
const BLOCKING: readonly string[] = ["blocker", "major"];

export async function gatherFacts(
  ctx: Ctx,
  s: SessionRow,
): Promise<Result<Gathered>> {
  if (s.ticket_id === null) {
    return err(frmError("validation", `session ${s.id} holds no ticket`));
  }
  const ticket = await getTicket(ctx.db, s.ticket_id);
  if (!ticket.ok) return ticket;
  const context = await readContext(ctx, s, s.ticket_id);
  if (!context.ok) return context;
  const worktrees = await listSessionWorktrees(ctx.db, s.id);
  if (!worktrees.ok) return worktrees;
  const live = worktrees.value.filter((w) => w.state !== "removed");
  const executor = ctx.executors.get(s.executor_id)?.executor;
  const repos =
    executor === undefined
      ? []
      : await Promise.all(live.map((w) => repoFacts(ctx, executor, w)));
  const c = context.value;
  const parsed = HandoffFacts.safeParse({
    v: 1,
    ticket: {
      id: ticket.value.id,
      key: ticketKey(c.prefix, ticket.value.num),
      status: ticket.value.status,
    },
    session: { id: s.id, role: s.role, run_class: s.run_class },
    repos,
    ...(executor === undefined && live.length > 0
      ? { git_error: `executor ${s.executor_id} is not loaded` }
      : {}),
    commands: c.commands,
    gates: c.gates,
    findings_open: c.findingsOpen,
    questions: c.questions,
    spend: { session_usd: s.cost_usd, ticket_usd: c.ticketUsd },
    counters: {
      turns: s.turns,
      max_turns: c.maxTurns,
      tool_calls: s.tool_calls,
      context_peak_tokens: s.context_peak_tokens,
      context_cap: c.contextCap,
    },
    events: { first_id: c.events.first, last_id: c.events.last },
    gathered_at: ctx.clock.now(),
  });
  if (!parsed.success) {
    return err(
      frmError("internal", `hand-off facts: ${z.prettifyError(parsed.error)}`),
    );
  }
  const dir = live[0]?.path;
  return ok({
    facts: parsed.data,
    ...(executor === undefined || dir === undefined
      ? {}
      : { place: { executor, dir } }),
  });
}

interface Context {
  readonly prefix: string;
  readonly commands: readonly CommandFact[];
  readonly gates: readonly { kind: string; state: string; attempt: number }[];
  readonly findingsOpen: number;
  readonly questions: readonly { id: string; text: string }[];
  readonly ticketUsd: number;
  readonly maxTurns: number;
  readonly contextCap: number;
  readonly events: EventRange;
}

/** The ticket key prefix in force (tickets.key_prefix), else the default. */
export async function ticketKeyPrefix(ctx: Ctx): Promise<Result<string>> {
  const settings = await getSettings(ctx.db, ["tickets.key_prefix"]);
  if (!settings.ok) return settings;
  const prefix = TicketKeyPrefix.safeParse(
    settings.value.get("tickets.key_prefix"),
  );
  return ok(prefix.success ? prefix.data : DEFAULT_TICKET_KEY_PREFIX);
}

/** Everything but git: the rows and counters the facts come from. */
async function readContext(
  ctx: Ctx,
  s: SessionRow,
  ticketId: string,
): Promise<Result<Context>> {
  const prefix = await ticketKeyPrefix(ctx);
  if (!prefix.ok) return prefix;
  const commands = await listSessionCommands(ctx.db, s.id, COMMANDS_READ);
  if (!commands.ok) return commands;
  const gates = await listTicketGates(ctx.db, ticketId);
  if (!gates.ok) return gates;
  const findings = await listTicketFindings(ctx.db, ticketId);
  if (!findings.ok) return findings;
  const questions = await listTicketHumanRequests(
    ctx.db,
    ticketId,
    QUESTIONS_READ,
  );
  if (!questions.ok) return questions;
  const economics = await getTicketEconomics(ctx.db, ticketId);
  if (!economics.ok) return economics;
  const runClass = await findRunClass(ctx, s.run_class);
  if (!runClass.ok) return runClass;
  const events = await getSessionEventRange(ctx.db, s.id);
  if (!events.ok) return events;
  return ok({
    prefix: prefix.value,
    commands: commandFacts(commands.value),
    gates: gates.value.map((g) => ({
      kind: g.kind,
      state: g.state,
      attempt: g.attempt,
    })),
    findingsOpen: findings.value.filter(
      (f) => f.status === "open" && BLOCKING.includes(f.severity),
    ).length,
    questions: questions.value
      .filter((q) => q.status === "open")
      .slice(0, QUESTIONS_KEPT)
      .map((q) => ({ id: q.id, text: q.question.slice(0, QUESTION_CHARS) })),
    ticketUsd: economics.value.cost_usd ?? 0,
    maxTurns: runClass.value.max_turns,
    contextCap: runClass.value.context_tokens_cap,
    events: events.value,
  });
}

const CommandPayload = z.object({ argv: z.array(z.string()).min(1) });

/** The latest run of each distinct command, newest first: what ran and how it ended. */
function commandFacts(rows: readonly EventRow[]): CommandFact[] {
  const latest = new Map<string, CommandFact>();
  for (const e of rows) {
    const payload = CommandPayload.safeParse(parseJson(e.payload_json));
    if (!payload.success) continue;
    const key = JSON.stringify(payload.data.argv);
    if (latest.has(key) || latest.size === COMMANDS_KEPT) continue;
    latest.set(key, {
      argv: payload.data.argv,
      exit_code: e.exit_code,
      status: e.status,
    });
  }
  return [...latest.values()];
}

/**
 * One worktree: head, commits since base, and every changed path (git status ∪ diff vs base). A
 * superproject's submodule commits are published into their mirrors before the facts are sealed and
 * their HEADs recorded, so the successor this packet is for can reach every gitlink.
 */
async function repoFacts(
  ctx: Ctx,
  executor: Executor,
  w: WorktreeRow,
): Promise<RepoFacts> {
  const base = { repo_id: w.repo_id, branch: w.branch, base_sha: w.base_sha };
  const published = await publishSubmodules(
    { db: ctx.db, exec: ctx, executor, mirrors: ctx.mirrors },
    w,
  );
  if (!published.ok) {
    // Never blocks the hand-off, as a git failure never does; the gate's own H1 check still
    // refuses a gitlink whose commit no mirror holds.
    ctx.log.warn(
      { worktree: w.id, error: published.error },
      "cannot publish the worktree's submodule commits",
    );
  }
  const subs =
    published.ok && published.value.length > 0
      ? { submodules: [...published.value] }
      : {};
  const git = async (args: readonly [string, ...string[]]) => {
    const what = `git ${args[0]}`;
    return exitedOk(
      // The worktree is agent-writable, so its own config never picks the flags.
      await runArgv(
        ctx,
        executor,
        ["git", ...safeGitArgs(["-C", w.path, ...args])],
        {
          what,
          // Where the executor places sessions (a container), git runs in the worktree, there.
          ...(executor.placeSession === undefined ? {} : { cwd: w.path }),
        },
      ),
      what,
    );
  };
  const head = await git(["rev-parse", "HEAD"]);
  const commits = await git(["rev-list", "--count", `${w.base_sha}..HEAD`]);
  const status = await git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const numstat = await git(["diff", "--numstat", "-z", w.base_sha]);
  if (!head.ok) return { ...base, ...subs, ...noGit(head.error.message) };
  if (!commits.ok) return { ...base, ...subs, ...noGit(commits.error.message) };
  if (!status.ok) return { ...base, ...subs, ...noGit(status.error.message) };
  if (!numstat.ok) return { ...base, ...subs, ...noGit(numstat.error.message) };
  return {
    ...base,
    ...subs,
    head_sha: head.value.stdout.trim() || null,
    commits: Number.parseInt(commits.value.stdout.trim(), 10) || 0,
    files: changedFiles(status.value.stdout, numstat.value.stdout),
  };
}

const noGit = (why: string) => ({
  head_sha: null,
  commits: 0,
  files: [],
  git_error: why,
});

/** `git status --porcelain=v1 -z`: `XY path\0`; a rename or copy adds `orig\0`. Path → code. */
export function parsePorcelain(out: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i] ?? "";
    i += 1;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    files.set(entry.slice(3), code.trim());
    if (code.startsWith("R") || code.startsWith("C")) i += 1;
  }
  return files;
}

interface Counts {
  readonly added?: number;
  readonly removed?: number;
}

/** `git diff --numstat -z`: `a\tr\tpath\0`, a rename `a\tr\t\0old\0new\0`; `-` for a binary. */
export function parseNumstat(out: string): ReadonlyMap<string, Counts> {
  const files = new Map<string, Counts>();
  const tokens = out.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const [added = "", removed = "", path = ""] = (tokens[i] ?? "").split("\t");
    i += 1;
    if (added === "") continue;
    let name = path;
    if (name === "") {
      name = tokens[i + 1] ?? "";
      i += 2;
    }
    const counts =
      added === "-" ? {} : { added: Number(added), removed: Number(removed) };
    if (name !== "") files.set(name, counts);
  }
  return files;
}

/** Every changed path, sorted: its porcelain code, or `committed` if it is clean now. */
export function changedFiles(
  porcelain: string,
  numstat: string,
): HandoffFile[] {
  const dirty = parsePorcelain(porcelain);
  const counts = parseNumstat(numstat);
  const paths = [...new Set([...dirty.keys(), ...counts.keys()])].toSorted();
  return paths.map((path) => ({
    path,
    code: dirty.get(path) ?? "committed",
    ...counts.get(path),
  }));
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
