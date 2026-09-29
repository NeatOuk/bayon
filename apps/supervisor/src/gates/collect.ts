// A reviewer's evidence, built in its session's afterExit: the process is
// closed and the executor still holds the session. Schema mode reads SendSpec.output's file back
// through the executor (cat must exit 0); heuristic mode reads the last assistant_text event (the
// stream, never a transcript: Invariant 2) and holds it to its FINDINGS sentinel (C2). The
// artifacts land under <FRM_HOME>/artifacts/gates/<id>/; core assembleEvidence does the rest.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_REVIEW_OUTPUT_CHARS,
  assembleEvidence,
  countSentinel,
  QaEvidence,
  err,
  ok,
  parseReviewOutput,
  type FindingsParse,
  type GateFailReason,
  type ReviewFinding,
  type Result,
  type SourceChanges,
} from "@bayon/core";
import {
  getEventsSince,
  getRunSpend,
  getRunner,
  getSession,
  type Db,
  type EventRow,
} from "@bayon/db";
import type { Executor } from "@bayon/executors";
import type { AfterExitFacts } from "../lifecycle/after-exit.js";
import { frmError } from "../lifecycle/errors.js";
import { runArgv, type ExecCtx } from "../lifecycle/exec.js";
import { outputFile, sessionPathsOn } from "../lifecycle/paths.js";
import { git, type GitCtx } from "./git.js";
import { QA_RUN_FILE } from "../jobs/qa-agent.js";
import type { ReviewerChoice } from "./pick.js";
import type { Pin } from "./subject.js";

export interface Collected {
  readonly evidence: unknown;
  readonly findings: readonly ReviewFinding[];
}

export interface CollectInput {
  readonly db: Db;
  readonly frmHome: string;
  readonly exec: ExecCtx;
  readonly git: GitCtx;
  readonly gateId: string;
  readonly kind: string;
  readonly sessionId: string;
  readonly pin: Pin;
  readonly choice: ReviewerChoice;
  /** Drift found at pin under gates.base_drift = warn (never re-checked here: H4). */
  readonly baseDrift: boolean;
  readonly sourceChanges?: SourceChanges;
  readonly artifactsDir: string;
  readonly facts: AfterExitFacts;
}

interface Review {
  readonly findings: readonly ReviewFinding[];
  readonly parse: FindingsParse;
  readonly path: string;
}

const EVENTS_PAGE = 200;

export async function collect(i: CollectInput): Promise<Collected> {
  await mkdir(i.artifactsDir, { recursive: true, mode: 0o700 });
  const exitPath = join(i.artifactsDir, "exit.json");
  const exit = {
    code: i.facts.exit.code ?? null,
    signal: i.facts.exit.signal ?? null,
  };
  await writeFile(exitPath, `${JSON.stringify(exit)}\n`, { mode: 0o600 });
  const subjectPath = await writeSubject(i);
  const run = i.facts.run;
  if (run === null)
    return { evidence: { reason: "reviewer_error" }, findings: [] };
  const review = run.state === "ok" ? await readReview(i, run.seq) : null;
  const reason: GateFailReason | undefined =
    run.state === "timeout"
      ? "timeout"
      : review === null || !review.ok
        ? "reviewer_error"
        : undefined;
  const session = await getSession(i.db, i.sessionId);
  if (!session.ok)
    return { evidence: { reason: reason ?? "reviewer_error" }, findings: [] };
  const runner = await getRunner(i.db, session.value.runner_id);
  const spend = await getRunSpend(i.db, run.id);
  const reviewed = review !== null && review.ok ? review.value : null;
  const findings =
    reason === undefined && reviewed !== null ? reviewed.findings : [];
  // A qa_harness gate's own run, as the job recorded it: the project's command with its
  // placeholders filled, its exit status, and the reports its globs matched, already copied into
  // these artifacts. Read from disk because the job's process is gone by now, and it is the job —
  // not this engine — that knows what a project's harness did. Absent for every other kind, and for
  // a QA gate whose job never got far enough to write it.
  const qa = await readQaRun(i.artifactsDir);
  const evidence = assembleEvidence({
    kind: i.kind,
    exit,
    run: { id: run.id, started_at: run.started_at, ended_at: run.ended_at },
    session: {
      id: session.value.id,
      runner_id: session.value.runner_id,
      executor_id: session.value.executor_id,
      model: session.value.model,
    },
    runnerVersion: runner.ok ? runner.value.version_detected : null,
    costUsd: spend.ok && spend.value !== null ? spend.value.cost_usd : 0,
    artifactPaths: [
      i.pin.diffPath,
      subjectPath,
      exitPath,
      ...(reviewed === null ? [] : [reviewed.path]),
      ...(qa === null
        ? []
        : [join(i.artifactsDir, QA_RUN_FILE), ...qa.reports]),
      session.value.raw_log_path,
    ],
    subject: {
      repo_id: i.pin.repoId,
      base_sha: i.pin.base,
      head_sha: i.pin.head,
      files: i.pin.files.length,
    },
    findings,
    parse: reviewed?.parse ?? (i.choice.outputSchema ? "schema" : "heuristic"),
    flags: {
      ...(i.choice.singleRunnerReview ? { single_runner_review: true } : {}),
      ...(i.choice.fallbackFrom === null
        ? {}
        : { fallback_from: i.choice.fallbackFrom }),
      ...(i.baseDrift ? { base_drift: true } : {}),
    },
    ...(i.sourceChanges === undefined
      ? {}
      : { sourceChanges: i.sourceChanges }),
    // §10.3's `command` is the harness's own line for a QA gate, not the generic "kind base..head
    // by runner" one: it is the command an operator reading the evidence has to be able to run.
    ...(qa === null ? {} : { commandLine: qa.command, qa }),
    ...(reason === undefined ? {} : { reason }),
  });
  return { evidence, findings };
}

/**
 * `qa-run.json` from the gate's artifacts, parsed; null when the file is absent (every other gate
 * kind) or does not parse. Never throws: a QA gate whose run file is unreadable still gets its
 * evidence, with the generic command line and no `qa` block, and `decideGate` then records the run
 * as `error` — which is the truth about what is known.
 */
async function readQaRun(artifactsDir: string): Promise<QaEvidence | null> {
  let text: string;
  try {
    text = await readFile(join(artifactsDir, QA_RUN_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = QaEvidence.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** subject.json: the pin, and the tip now by a local rev-parse (no fetch: recorded only, H4). */
async function writeSubject(i: CollectInput): Promise<string> {
  const now = await git(i.git, i.pin.mirror, [
    "rev-parse",
    "--verify",
    `${i.pin.baseRef}^{commit}`,
  ]);
  const path = join(i.artifactsDir, "subject.json");
  const subject = {
    repo_id: i.pin.repoId,
    base: i.pin.base,
    head: i.pin.head,
    tip_at_pin: i.pin.tip,
    tip_at_collect: now.ok ? now.value : null,
    files: i.pin.files,
  };
  await writeFile(path, `${JSON.stringify(subject, null, 2)}\n`, {
    mode: 0o600,
  });
  return path;
}

async function readReview(
  i: CollectInput,
  seq: number,
): Promise<Result<Review>> {
  const text = i.choice.outputSchema
    ? await readOutputFile(i, seq)
    : await lastAssistantText(i.db, i.sessionId);
  if (!text.ok) return text;
  const path = join(
    i.artifactsDir,
    i.choice.outputSchema ? "output.json" : "output.txt",
  );
  await writeFile(path, text.value, { mode: 0o600 });
  const parsed = parseReviewOutput(text.value, i.choice.outputSchema);
  if (!parsed.ok) return parsed;
  if (!i.choice.outputSchema) {
    const declared = countSentinel(text.value);
    if (declared !== parsed.value.findings.length) {
      return err(
        frmError(
          "validation",
          `the review declares ${String(declared)} findings (FINDINGS line), ${parsed.value.findings.length} were read`,
        ),
      );
    }
  }
  return ok({
    findings: parsed.value.findings,
    parse: parsed.value.parse,
    path,
  });
}

/**
 * SendSpec.output's file for run `seq` of the session, where the session's executor put it: a
 * container's is under the root it mounts, read in that container.
 */
const readOutputFile = (
  i: CollectInput,
  seq: number,
): Promise<Result<string>> => {
  const paths = sessionPathsOn(i.frmHome, i.sessionId, i.facts.executor);
  return readReviewFile(
    i.exec,
    i.facts.executor,
    outputFile(paths, seq),
    paths.remote ? paths.root : undefined,
  );
};

/**
 * A review file through the executor that holds it. cat must exit 0; the read stops at
 * MAX_REVIEW_OUTPUT_CHARS + 1 and kills cat, so an oversized output is refused without ever being
 * held whole: a validation error, and the gate fails reviewer_error. `cwd` is
 * where cat runs, for an executor whose programs run only in the session's root (a container).
 */
export async function readReviewFile(
  exec: ExecCtx,
  executor: Executor,
  file: string,
  cwd?: string,
): Promise<Result<string>> {
  const ran = await runArgv(exec, executor, ["cat", "--", file], {
    what: "read the review output",
    maxStdoutChars: MAX_REVIEW_OUTPUT_CHARS,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (!ran.ok) return ran;
  if (ran.value.overflow === true) {
    return err(
      frmError(
        "validation",
        `review output ${file} is over the ${MAX_REVIEW_OUTPUT_CHARS}-character cap`,
      ),
    );
  }
  return ran.value.code === 0
    ? ok(ran.value.stdout)
    : err(
        frmError(
          "runner_error",
          `cat ${file} exited ${String(ran.value.code)}: no review output`,
        ),
      );
}

/** The session's last assistant_text: its text, or its capped payload file. */
async function lastAssistantText(
  db: Db,
  sessionId: string,
): Promise<Result<string>> {
  let since = 0;
  let last: EventRow | undefined;
  for (;;) {
    const page = await getEventsSince(db, {
      sessionId,
      since,
      kinds: ["assistant_text"],
      limit: EVENTS_PAGE,
    });
    if (!page.ok) return page;
    last = page.value.rows.at(-1) ?? last;
    if (!page.value.hasMore) break;
    since = page.value.nextCursor;
  }
  if (last === undefined) {
    return err(frmError("runner_error", "the reviewer wrote no answer"));
  }
  if (last.truncated === 1 && last.payload_path !== null) {
    try {
      return ok(await readFile(last.payload_path, "utf8"));
    } catch (e) {
      return err(
        frmError("internal", `cannot read ${last.payload_path}`, String(e)),
      );
    }
  }
  return ok(last.text ?? "");
}
