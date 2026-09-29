// The conformance ingest on the supervisor's own ingest: createIngest over a
// scratch database in the run's directory, so a result can certify while the system of record
// never holds a conformance session. Each suite session is a session row there and each run a
// runs row; events come back as the suite's StoredEvents, the supervisor's terminals marked so.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ok, type Clock, type FrmError, type Result } from "@bayon/core";
import {
  SUPERVISOR_RUNNER_TYPE,
  getEventsSince,
  openDb,
  toCanonical,
  type Db,
  type EventRow,
} from "@bayon/db";
import {
  appendRun,
  createSession,
  finishRun,
  migrateUp,
  seedConformanceScratch,
  upsertExecutor,
  upsertRegistration,
} from "@bayon/db/supervisor";
import type { Executor } from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import type { IngestPort, StoredEvent } from "@bayon/runners/conformance";
import type { Logger } from "pino";
import { registrationRows } from "../boot.js";
import { createIngest } from "../ingest/ingest.js";
import { rawLogPath } from "../paths.js";

const SCRATCH_AGENT = "conformance";
/** A run class 002 seeds; nothing reads it in a scratch database. */
const SCRATCH_RUN_CLASS = "probe";
const HASH = "0".repeat(64);
const EOF_CLOSE = {
  outcome: "failed",
  errorClass: "runner_exited_without_terminal",
  message: "the runner exited without a terminal event",
} as const;

export interface ScratchIngest {
  readonly port: IngestPort;
  /** The run timer's verdict (lifecycle/run.ts onTimeout): runs.state = timeout, by CAS. */
  timeout(runId: string, message: string): Promise<Result<unknown>>;
  dispose(): Promise<void>;
}

export interface ScratchIngestOptions {
  readonly dir: string;
  readonly clock: Clock;
  readonly log: Logger;
  readonly adapter: RunnerAdapter;
  readonly executor: Pick<Executor, "id" | "kind">;
  /** Secret values the suite's env holds: redacted from every record, as a session's are. */
  readonly redact: readonly string[];
}

async function scratchDb(
  o: ScratchIngestOptions,
): Promise<Result<{ readonly db: Db; readonly runnerId: string }>> {
  const rows = registrationRows(o.adapter.registration());
  if (!rows.ok) return rows;
  const opened = await openDb({
    path: join(o.dir, "ingest.db"),
    clock: o.clock,
  });
  if (!opened.ok) return opened;
  const db = opened.value;
  const runnerId = rows.value.runner.id;
  const steps: (() => Promise<Result<unknown>>)[] = [
    () => migrateUp(db),
    () => upsertRegistration(db, rows.value),
    () =>
      upsertExecutor(db, {
        id: o.executor.id,
        kind: o.executor.kind,
        config_json: "{}",
      }),
    () =>
      seedConformanceScratch(db, {
        agent_id: SCRATCH_AGENT,
        runner_id: runnerId,
        executor_id: o.executor.id,
      }),
  ];
  for (const step of steps) {
    const done = await step();
    if (!done.ok) {
      await db.close();
      return done;
    }
  }
  return ok({ db, runnerId });
}

const toStored = (row: EventRow): StoredEvent => {
  const { id, ...event } = toCanonical(row);
  const source =
    row.runner_type === SUPERVISOR_RUNNER_TYPE ? "supervisor" : "runner";
  return { ...event, source, seq: id };
};

async function eventRows(
  db: Db,
  sessionId: string,
  since: number,
): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (let at = since; ;) {
    const page = await getEventsSince(db, {
      sessionId,
      since: at,
      limit: 1000,
    });
    if (!page.ok) return out;
    out.push(...page.value.rows);
    if (!page.value.hasMore) return out;
    at = page.value.nextCursor;
  }
}

export async function scratchIngest(
  o: ScratchIngestOptions,
): Promise<Result<ScratchIngest>> {
  const opened = await scratchDb(o);
  if (!opened.ok) return opened;
  const { db, runnerId } = opened.value;
  let fatal: FrmError | null = null;
  const ingest = createIngest({
    db,
    clock: o.clock,
    log: o.log,
    onFatal: (e) => {
      fatal = e;
    },
  });
  const sessions = new Set<string>();
  const ended = new Map<string, Promise<void>>();
  const cursors = new Map<string, number>();
  let listeners: readonly ((sessionId: string, e: StoredEvent) => void)[] = [];
  let pump: Promise<void> = Promise.resolve();
  // Committed batches, told to onEvent listeners in id order, one session at a time.
  const offCommit = ingest.onCommit((c) => {
    pump = pump.then(async () => {
      for (const sessionId of c.sessionIds) {
        const fresh = await eventRows(
          db,
          sessionId,
          cursors.get(sessionId) ?? 0,
        );
        const last = fresh.at(-1);
        if (last !== undefined) cursors.set(sessionId, last.id);
        for (const row of fresh)
          for (const l of listeners) l(sessionId, toStored(row));
      }
    });
  });

  const port: IngestPort = {
    source: "supervisor",
    async attach(a) {
      if (!sessions.has(a.sessionId)) {
        const root = join(o.dir, "sessions", a.sessionId);
        const made = await createSession(db, {
          id: a.sessionId,
          agent_id: SCRATCH_AGENT,
          role: "conformance",
          run_class: SCRATCH_RUN_CLASS,
          runner_id: runnerId,
          executor_id: o.executor.id,
          session_root: root,
          home_dir: root,
          config_hash: HASH,
          raw_log_path: rawLogPath(o.dir, a.sessionId),
          mcp_token_hash: randomBytes(32).toString("hex"),
        });
        if (!made.ok) return made;
        sessions.add(a.sessionId);
      }
      const segment = await ingest.beginSegment(a.sessionId);
      if (!segment.ok) return segment;
      const attached = ingest.attach({
        sessionId: a.sessionId,
        handle: a.handle,
        adapter: a.adapter,
        segmentOffset: segment.value.offset,
        onEof: () => EOF_CLOSE,
        redact: [...(a.redact ?? []), ...o.redact],
      });
      if (!attached.ok) return attached;
      ended.set(
        a.sessionId,
        attached.value.closed.then(
          () => undefined,
          () => undefined, // fatal() says why
        ),
      );
      return ok(undefined);
    },
    async openRun(sessionId, runId) {
      const run = await appendRun(db, {
        id: runId,
        session_id: sessionId,
        trigger: "operator",
        prompt_path: "/dev/null",
        prompt_hash: HASH,
        context_hash: HASH,
      });
      return run.ok ? ingest.openRun(sessionId, runId) : run;
    },
    events: async (sessionId) =>
      (await eventRows(db, sessionId, 0)).map(toStored),
    raw: (sessionId) =>
      readFile(rawLogPath(o.dir, sessionId)).then(
        (bytes) => new Uint8Array(bytes),
        () => new Uint8Array(),
      ),
    terminalOf: (runId) => ingest.terminalOf(runId),
    closeRun: (sessionId, runId, c) => ingest.closeRun(sessionId, runId, c),
    ended: (sessionId) => ended.get(sessionId) ?? Promise.resolve(),
    onEvent(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    fatal: () => fatal,
  };

  return ok({
    port,
    timeout: (runId, message) =>
      finishRun(db, runId, {
        state: "timeout",
        error_class: "timeout",
        error_message: message,
      }),
    async dispose() {
      offCommit();
      await ingest.shutdown();
      await pump;
      await db.close();
    },
  });
}
