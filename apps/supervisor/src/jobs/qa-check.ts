// The QA checker's child process: the `script` runner's argv points here. Read-only on
// the DB -- it writes no row; `decideGate` is the gate's only writer (rule 2) and the gate engine
// calls it from this session's afterExit. Speaks the same tiny stdin/stdout protocol every script
// job speaks (`@bayon/runners/script`): wait for `send`, emit canonical JSONL, exit only on stdin
// EOF.
//
// Its one answer is an `assistant_text` carrying `qaReport`: the findings as an embedded
// ReviewOutput JSON and the `FINDINGS: <n>` sentinel, which is what a runner without `outputSchema`
// is held to (and `collect()` checks the two agree).
//
// It works in the gate's pinned worktree: `sessionRoots` gives a session with a `gate_id` its one
// worktree as cwd, which is the commit under review checked out detached. A harness has to have the
// files, so this takes the lint job's branch and not parity's.
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TICKET_KEY_PREFIX,
  qaReport,
  qaSecretName,
  qaTimeoutOf,
  systemClock,
  ticketKey,
  type QaValues,
} from "@bayon/core";
import {
  getSettings,
  getTicket,
  getWorkspace,
  openDbReadOnly,
  qaConfigOf,
  type Db,
} from "@bayon/db";
import { hostSecrets } from "@bayon/executors";
import { emit, readOps, type ScriptIo } from "@bayon/runners/script";
import { z } from "zod";
import { jobHome } from "./job-env.js";
import {
  QA_ARTIFACTS_ENV,
  QA_TICKET_ENV,
  QA_WORKSPACE_ENV,
} from "./qa-agent.js";
import { qaFindingsOf, runQaJob, type ResolvedSecret } from "./qa-run.js";
import { pump } from "./script-pump.js";

/**
 * The job's whole input. Both QA names carry what the gate pinned and are **required**: a job that
 * guessed its project would run one project's harness and report the answer as another's, and a job
 * with nowhere to put the output would either drop it or push a test runner's whole log into an
 * event payload (Invariant 9).
 *
 * `FRM_QA_TICKET_ID` names the ticket whose row the three placeholders come from.
 *
 * `FRM_HOME` and `HOME` are required for the other reason: `jobHome` recomputes this
 * session's private home from the first and holds the second to it, so a project's declared command
 * cannot be run under a home this session does not own.
 */
const Env = z.object({
  FRM_DB: z.string().min(1),
  FRM_HOME: z.string().min(1),
  FRM_SESSION_ID: z.string().min(1),
  HOME: z.string().min(1),
  [QA_WORKSPACE_ENV]: z.string().min(1),
  [QA_TICKET_ENV]: z.string().min(1),
  [QA_ARTIFACTS_ENV]: z.string().min(1),
});

const ZERO_USAGE = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

function fail(io: ScriptIo, message: string): void {
  const error = { class: "internal", message, retryable: false };
  emit(io, { kind: "error", runner_type: "qa.error", payload: error });
  emit(io, {
    kind: "terminal",
    runner_type: "qa.terminal",
    payload: { outcome: "failed", error, usage: ZERO_USAGE, cost_usd: 0 },
  });
}

/**
 * The secrets the project named, from the host store (`FRM_SECRET_<NAME>`, then the Keychain or the
 * file store — the same store a spawn resolves from). A name the store does not hold is a failure
 * **before the harness runs**: nothing judged the code, so the gate ends `reviewer_error` rather
 * than blaming a change for a credential the fleet is missing. The message names the secret; a
 * value never reaches a message, a log or an event.
 */
async function resolveSecrets(
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ ok: true; value: ResolvedSecret[] } | { ok: false; why: string }> {
  if (names.length === 0) return { ok: true, value: [] };
  // `env` carries the supervisor's FRM_HOME, so this reads that install's service.
  const store = hostSecrets(env);
  if (!store.ok) return { ok: false, why: store.error.message };
  const found: ResolvedSecret[] = [];
  for (const raw of names) {
    const name = qaSecretName(raw);
    if (!name.ok) return { ok: false, why: name.error.message };
    const value = await store.value.spawn.get(name.value);
    if (!value.ok) {
      return {
        ok: false,
        why: `${value.error.message}: this project's QA harness declares it, so the harness was not run and the gate decides nothing about this change. Store the secret, then run the gate again`,
      };
    }
    found.push([name.value, value.value] as const);
  }
  return { ok: true, value: found };
}

async function runOnce(io: ScriptIo, signal: AbortSignal): Promise<void> {
  emit(io, {
    kind: "session_init",
    runner_type: "qa.init",
    payload: { runner_session_id: randomUUID(), model: "script" },
  });

  const env = Env.safeParse(process.env);
  if (!env.success)
    return fail(io, `bad environment: ${z.prettifyError(env.error)}`);
  const workspaceId = env.data[QA_WORKSPACE_ENV];
  // Before the database and a long way before a project-declared command: the session-private home
  // that command is confined to, recomputed rather than inherited.
  const at = jobHome(process.env);
  if (!at.ok) return fail(io, at.error.message);

  const db = await openDbReadOnly({
    path: env.data.FRM_DB,
    clock: systemClock,
  });
  if (!db.ok)
    return fail(io, `cannot open the database read-only: ${db.error.message}`);

  try {
    const workspace = await getWorkspace(db.value, workspaceId);
    if (!workspace.ok) return fail(io, workspace.error.message);
    const config = qaConfigOf(workspace.value);
    // No command is a failure, never a clean pass: a gate that ran nothing and reported a good
    // project would certify a tree it never looked at (Invariant 10). Since the round opens this
    // gate only for `qa_mode = 'command'`, reaching here means the row changed between the plan and
    // the run -- a race, and the message names what to set.
    if (config.mode !== "command") {
      return fail(
        io,
        `project ${workspaceId} is not in QA mode \`command\` (it is \`${config.mode}\`): its harness was not run, so the gate decides nothing about this change`,
      );
    }
    const ticket = await getTicket(db.value, env.data[QA_TICKET_ENV]);
    if (!ticket.ok) return fail(io, ticket.error.message);
    const prefix = await keyPrefix(db.value);
    const values: QaValues = {
      ticket: ticketKey(prefix, ticket.value.num),
      external_key: ticket.value.origin_ref ?? "",
      branch: ticket.value.branch ?? "",
    };
    const secrets = await resolveSecrets(config.secrets, process.env);
    if (!secrets.ok) return fail(io, secrets.why);

    const ran = await runQaJob({
      cwd: process.cwd(),
      workspaceId,
      config,
      values,
      secrets: secrets.value,
      artifactsDir: env.data[QA_ARTIFACTS_ENV],
      env: process.env,
      at: at.value,
      timeoutMs: qaTimeoutOf(config.timeout_ms),
      signal,
      now: () => systemClock.now(),
    });
    if (!ran.ok) return fail(io, ran.error.message);
    const { outcome } = ran.value;
    // A harness that could not run is a reviewer error, not a verdict about the change: it fails
    // the run, so the gate ends `reviewer_error` and an earlier change keeps the ticket off the fix path.
    if (outcome.state === "reviewer_error") return fail(io, outcome.message);
    const findings = qaFindingsOf(outcome);
    emit(io, {
      kind: "assistant_text",
      runner_type: "qa.report",
      text: qaReport(workspace.value.name, findings),
      payload: {},
    });
    emit(io, {
      kind: "terminal",
      runner_type: "qa.terminal",
      payload: {
        outcome: "ok",
        usage: ZERO_USAGE,
        cost_usd: 0,
        workspace_id: workspaceId,
        exit_code: ran.value.exitCode,
        findings: findings.length,
        reports: ran.value.reports.length,
      },
    });
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  } finally {
    await db.value.close();
  }
}

/** `settings.tickets.key_prefix`, for `{ticket}`; the default when it cannot be read. */
async function keyPrefix(db: Db): Promise<string> {
  const rows = await getSettings(db, ["tickets.key_prefix"]);
  const value = rows.ok ? rows.value.get("tickets.key_prefix") : undefined;
  return typeof value === "string" && value !== ""
    ? value
    : DEFAULT_TICKET_KEY_PREFIX;
}

/**
 * Reads stdin to its end regardless of what `runOnce` did: the job exits only on stdin EOF (never
 * self-terminates), exactly like the lint job and the exporter. `pump` is what keeps stdin read
 * *while* the project's harness runs — which is this job's entire life, and so the only window in
 * which an `interrupt` can reach the signal `runCommand` kills its group on.
 */
async function main(): Promise<void> {
  const io: ScriptIo = {
    stdout: { write: (chunk) => void process.stdout.write(chunk) },
  };
  try {
    await pump(readOps(process.stdin), (signal) => runOnce(io, signal));
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && entry.endsWith("qa-check.js");
}

if (isMain()) {
  await main();
  process.exitCode = 0;
}
