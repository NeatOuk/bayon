// The parity checker's child process: the `script` runner's argv points here. Read-only
// on the DB and on the mirrors -- it writes no row and fetches nothing; `decideGate` is the gate's
// only writer (rule 2) and the gate engine calls it from this session's afterExit. Speaks the same
// tiny stdin/stdout protocol every script job speaks (`@bayon/runners/script`): wait for `send`,
// emit canonical JSONL, exit only on stdin EOF.
//
// Its one answer is an `assistant_text` carrying `parityReport`: the findings as an embedded
// ReviewOutput JSON and the `FINDINGS: <n>` sentinel, which is what a runner without `outputSchema`
// is held to (and `collect()` checks the two agree).
import { randomUUID } from "node:crypto";
import { parityFindings, parityReport, systemClock } from "@bayon/core";
import { openDbReadOnly } from "@bayon/db";
import { emit, readOps, type ScriptIo } from "@bayon/runners/script";
import { z } from "zod";
import { PARITY_HEAD_ENV, PARITY_REPO_ENV } from "./parity-agent.js";
import { gatherParity, hostMirrorGit } from "./parity-facts.js";
import { pump } from "./script-pump.js";

/**
 * The job's whole input. The two parity names carry the gate's pin (H1) and are
 * **required**: without them the walk would start from `base_sha` — `worktrees.head_sha` has no
 * writer — and the gate would certify the commit the ticket began at. Failing loudly here is what
 * keeps that from ever being reported as a clean workspace.
 */
const Env = z.object({
  FRM_DB: z.string().min(1),
  FRM_SESSION_ID: z.string().min(1),
  [PARITY_REPO_ENV]: z.string().min(1),
  [PARITY_HEAD_ENV]: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});

const ZERO_USAGE = {
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

function fail(io: ScriptIo, message: string): void {
  const error = { class: "internal", message, retryable: false };
  emit(io, { kind: "error", runner_type: "parity.error", payload: error });
  emit(io, {
    kind: "terminal",
    runner_type: "parity.terminal",
    payload: { outcome: "failed", error, usage: ZERO_USAGE, cost_usd: 0 },
  });
}

async function runOnce(io: ScriptIo, signal: AbortSignal): Promise<void> {
  emit(io, {
    kind: "session_init",
    runner_type: "parity.init",
    payload: { runner_session_id: randomUUID(), model: "script" },
  });

  const env = Env.safeParse(process.env);
  if (!env.success)
    return fail(io, `bad environment: ${z.prettifyError(env.error)}`);

  const db = await openDbReadOnly({
    path: env.data.FRM_DB,
    clock: systemClock,
  });
  if (!db.ok)
    return fail(io, `cannot open the database read-only: ${db.error.message}`);

  try {
    const gathered = await gatherParity({
      db: db.value,
      git: hostMirrorGit(),
      sessionId: env.data.FRM_SESSION_ID,
      pinned: {
        repoId: env.data[PARITY_REPO_ENV],
        sha: env.data[PARITY_HEAD_ENV],
      },
      signal,
    });
    if (!gathered.ok) return fail(io, gathered.error.message);
    const findings = [
      ...gathered.value.findings,
      ...parityFindings(gathered.value.facts),
    ];
    emit(io, {
      kind: "assistant_text",
      runner_type: "parity.report",
      text: parityReport(findings),
      payload: {},
    });
    emit(io, {
      kind: "terminal",
      runner_type: "parity.terminal",
      payload: {
        outcome: "ok",
        usage: ZERO_USAGE,
        cost_usd: 0,
        workspace_id: gathered.value.workspaceId,
        findings: findings.length,
      },
    });
  } catch (e) {
    fail(io, e instanceof Error ? e.message : String(e));
  } finally {
    await db.value.close();
  }
}

/** Reads stdin to its end regardless of what `runOnce` did: the job exits only on stdin EOF (never
 * self-terminates), exactly like the exporter and the fixture runner. `pump` is what keeps stdin
 * read while `gatherParity` walks this host's mirrors, so the signal it is handed can actually
 * fire — this job had the same unreachable `interrupt` the lint job's review found. */
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
  return entry !== undefined && entry.endsWith("parity-check.js");
}

if (isMain()) {
  await main();
  process.exitCode = 0;
}
