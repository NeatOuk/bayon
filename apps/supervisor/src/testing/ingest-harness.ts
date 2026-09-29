// Test support for the ingest tests: the fixture runner in-process under FakeExecutor, sessions
// with their raw logs under a temp FRM_HOME, and a counting wrapper around insertEventsBatch.
// No SQL and no @bayon/db/testing here: the tests pass in the seed inputs.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Result, SessionState } from "@bayon/core";
import { getEventsSince, type Db, type EventRow } from "@bayon/db";
import {
  appendRun,
  createSession,
  insertEventsBatch,
  updateSessionState,
  type NewRun,
  type NewSession,
} from "@bayon/db/supervisor";
import { FakeExecutor } from "@bayon/executors/testing";
import type { ModelRow, SessionHandle, SpawnSpec } from "@bayon/runners";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
  type FixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/testing";
import type { Attachment, Ingest, SupervisorClose } from "../ingest/ingest.js";
import { rawLogPath } from "../paths.js";

/** What the lifecycle's onEof returns when a stream ends with a run open. */
export const EOF_CLOSE: SupervisorClose = {
  outcome: "failed",
  errorClass: "runner_exited_without_terminal",
  message: "the runner exited without a terminal event",
};

export function must<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.class}: ${result.error.message}`, {
    cause: result.error,
  });
}

/** insertEventsBatch, counting calls and rows; `crashOn` throws before that call commits. */
export function countingInsert(o: { crashOn?: number } = {}) {
  const stats = { calls: 0, rows: 0 };
  const insert: typeof insertEventsBatch = async (db, rows) => {
    stats.calls += 1;
    if (stats.calls === o.crashOn)
      throw new Error("injected crash before commit");
    stats.rows += rows.length;
    return insertEventsBatch(db, rows);
  };
  return { insert, stats };
}

export interface Segment {
  readonly sessionId: string;
  readonly handle: SessionHandle;
  readonly attachment: Attachment;
  readonly offset: number;
}

export interface IngestHarness {
  readonly adapter: FixtureAdapter;
  /** A new session whose raw log lives under `home`. */
  session(): Promise<string>;
  /** beginSegment → spawn (or adopt) → record raw_segment_offset (the lifecycle's edge 4) → attach. */
  start(
    ingest: Ingest,
    sessionId: string,
    script: FixtureScriptInput,
    o?: {
      readonly resume?: string;
      readonly redact?: readonly string[];
      /** Told the prices ingest hands the segment's mapper. */
      readonly watchPrices?: (prices: readonly ModelRow[]) => void;
    },
  ): Promise<Segment>;
  /** appendRun → openRun → send; resolves with the run id. */
  send(ingest: Ingest, s: Segment): Promise<string>;
  /** Every stored event of a session, in id order. */
  stored(sessionId: string): Promise<EventRow[]>;
}

const LIVE: readonly SessionState[] = ["pending", "idle", "running"];

export function ingestHarness(o: {
  readonly db: Db;
  readonly home: string;
  readonly sessionInput: () => NewSession;
  readonly runInput: (sessionId: string) => NewRun;
}): IngestHarness {
  const executor = new FakeExecutor({
    programs: { [FIXTURE_PROGRAM]: fixtureProgram },
  });
  const adapter = createFixtureAdapter({ command: [FIXTURE_PROGRAM] });
  let sessions = 0;

  const spec = (sessionId: string, script: FixtureScriptInput): SpawnSpec => {
    const cwd = join(o.home, "work", sessionId);
    const homeDir = join(o.home, "runtime", "sessions", sessionId, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    return {
      sessionId,
      cwd,
      homeDir,
      env: {},
      model: "fixture-model",
      flags: { script },
    };
  };

  return {
    adapter,
    async session() {
      sessions += 1;
      const id = `session-${sessions}`;
      must(
        await createSession(o.db, {
          ...o.sessionInput(),
          id,
          raw_log_path: rawLogPath(o.home, id),
        }),
      );
      return id;
    },
    async start(ingest, sessionId, script, so = {}) {
      const { offset } = must(await ingest.beginSegment(sessionId));
      const s = spec(sessionId, script);
      const handle = must(
        so.resume === undefined
          ? await adapter.spawn(s, executor)
          : await adapter.adopt(
              { ...s, resumeRunnerSessionId: so.resume },
              executor,
            ),
      );
      must(
        await updateSessionState(o.db, sessionId, {
          from: LIVE,
          to: "idle",
          patch: { raw_segment_offset: offset },
        }),
      );
      const attachment = must(
        ingest.attach({
          sessionId,
          handle,
          adapter:
            so.watchPrices === undefined
              ? adapter
              : {
                  records: (h) => adapter.records(h),
                  registration: () => adapter.registration(),
                  createMapper: (m) => {
                    so.watchPrices?.(m.prices);
                    return adapter.createMapper(m);
                  },
                },
          segmentOffset: offset,
          onEof: () => EOF_CLOSE,
          ...(so.redact === undefined ? {} : { redact: so.redact }),
        }),
      );
      return { sessionId, handle, attachment, offset };
    },
    async send(ingest, s) {
      const run = must(await appendRun(o.db, o.runInput(s.sessionId)));
      must(await ingest.openRun(s.sessionId, run.id));
      must(
        await adapter.send(s.handle, {
          runId: run.id,
          text: "go",
          promptPath: "/dev/null",
        }),
      );
      return run.id;
    },
    async stored(sessionId) {
      const rows: EventRow[] = [];
      for (let since = 0; ;) {
        const page = must(
          await getEventsSince(o.db, { sessionId, since, limit: 1000 }),
        );
        rows.push(...page.rows);
        if (!page.hasMore) return rows;
        since = page.nextCursor;
      }
    },
  };
}

/** `n` assistant_text templates for a fixture script. */
export const texts = (n: number, prefix = "t") =>
  Array.from({ length: n }, (_, i) => ({
    kind: "assistant_text",
    runner_type: "fixture.text",
    text: `${prefix}${i}`,
    payload: {},
  }));
