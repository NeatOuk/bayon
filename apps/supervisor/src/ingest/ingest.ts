// Supervisor ingest (§9.4). Per process segment: each record is appended verbatim to the raw log
// (the write-ahead log for events), mapped by a fresh mapper, and batched into `events`. The
// first terminal of a run wins; after its commit come finishRun, the run's spend row, terminalOf
// and onTerminal. A stream that ends with a run open gets the supervisor's terminal at
// raw_offset = -runs.seq. After a crash, replay re-maps [raw_segment_offset, EOF) and inserts
// what never committed; the unique (session_id, runner_type, raw_offset) key dedupes the rest.
// Durability (M4 amendment): every commit that points into the raw log follows an fdatasync of
// it (live batches, replay, the segment start, a run's binding), and a segment never starts below
// committedEnd.
import { closeSync, statSync } from "node:fs";
import {
  err,
  ok,
  type CanonicalEvent,
  type CanonicalEventOf,
  type Clock,
  type ErrorClass,
  type FrmError,
  type Result,
  type RunOutcome,
} from "@bayon/core";
import {
  SUPERVISOR_RUNNER_TYPE,
  getFirstTerminal,
  getMaxRawOffset,
  getRun,
  getSession,
  getSupervisorState,
  toCanonical,
  type Db,
  type EventRow,
} from "@bayon/db";
import {
  finishRun,
  insertEventsBatch,
  insertSpend,
  setSupervisorState,
  type EventInsert,
} from "@bayon/db/supervisor";
import type {
  Mapper,
  ModelRow,
  RawRecord,
  RunnerAdapter,
  SessionHandle,
} from "@bayon/runners";
import type { Logger } from "pino";
import { z } from "zod";
import { toolDir } from "../paths.js";
import {
  BATCH_MAX_DELAY_MS,
  BATCH_MAX_ROWS,
  createBatcher,
} from "./batcher.js";
import {
  appendRecord,
  nodeRawLogFs,
  openAppender,
  prepareSegment,
  readRecords,
  syncRawLog,
  type LogRecord,
  type RawLogFs,
} from "./raw-log.js";
import { createRedactor } from "./redact.js";
import { demote, toRow } from "./rows.js";
import { committedEnd } from "./segment.js";
import { runnerPrices } from "./prices.js";
import { spendRow } from "./spend.js";

/** What ingest needs of an adapter: its records, a mapper per segment, and its prices. */
export type IngestAdapter = Pick<
  RunnerAdapter,
  "records" | "createMapper" | "registration"
>;

/** How the supervisor closes a run that has no terminal (onEof and closeRun). */
export interface SupervisorClose {
  readonly outcome: "timeout" | "interrupted" | "failed" | "budget_stop";
  readonly errorClass: ErrorClass;
  readonly message: string;
}

export interface TerminalNotice {
  readonly sessionId: string;
  readonly runId: string;
  readonly outcome: RunOutcome;
}

/** One committed batch, for the in-process bus. The cursor is its highest events.id. */
export interface Committed {
  readonly cursor: number;
  readonly inserted: number;
  readonly sessionIds: readonly string[];
}

export interface Attachment {
  /**
   * Resolves after EOF, once every event is committed and an open run has its terminal and
   * finishRun. Rejects with the FrmError only if ingest failed (the supervisor then exits).
   */
  readonly closed: Promise<{ readonly endOffset: number }>;
}

export interface AttachOptions {
  readonly sessionId: string;
  readonly handle: SessionHandle;
  readonly adapter: IngestAdapter;
  /** beginSegment's offset: the raw log's length when this process started. */
  readonly segmentOffset: number;
  /** Called at EOF only if a run is still open: how to close it. */
  readonly onEof: () => SupervisorClose;
  /**
   * Secret values this process's env holds (its MCP token, its resolved secrets): redacted from
   * every record before the raw-log append (Invariant 11). Held in memory only.
   */
  readonly redact?: readonly string[];
}

export interface Ingest {
  /**
   * Creates the raw log, ends a torn last line, pads it with empty lines up to committedEnd if it
   * is shorter, fdatasyncs it, and returns where the segment starts. Writes no row.
   */
  beginSegment(sessionId: string): Promise<Result<{ offset: number }>>;
  /** Starts reading `records(handle)`: the only reader. Requires beginSegment first. */
  attach(a: AttachOptions): Result<Attachment>;
  /** Binds later records to `runId`, durably, before `send`. A run still open is a conflict. */
  openRun(sessionId: string, runId: string): Promise<Result<void>>;
  /** The run's first terminal, once committed. Never rejects. */
  terminalOf(runId: string): Promise<RunOutcome>;
  /** Re-maps [raw_segment_offset, EOF) of a session whose process is gone. Idempotent. */
  replay(
    sessionId: string,
    adapter: IngestAdapter,
  ): Promise<Result<{ endOffset: number }>>;
  /** Writes the run's terminal (at -runs.seq) and finishRun, unless it has one already. The
   * outcome is runs.state when that is final, else `c.outcome`. */
  closeRun(
    sessionId: string,
    runId: string,
    c: SupervisorClose,
  ): Promise<Result<void>>;
  /** After each live first terminal and its finishRun and spend commit. Replay does not call it. */
  onTerminal(fn: (t: TerminalNotice) => void): () => void;
  /** The in-process bus (amendment 9: internal only; the API tails the database). */
  onCommit(fn: (c: Committed) => void): () => void;
  /** Stops reading, commits what is pending and closes the raw logs. Kills nothing. */
  shutdown(): Promise<void>;
}

export interface IngestOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly log: Logger;
  /** Ingest cannot continue (a batch failed): replay after a restart recovers. */
  readonly onFatal?: (error: FrmError) => void;
  /** Injected by tests to count or fail batches. */
  readonly insertEvents?: typeof insertEventsBatch;
  /** Injected by tests to order the raw log's fdatasyncs against the commits. */
  readonly fs?: RawLogFs;
  readonly maxRows?: number;
  readonly maxDelayMs?: number;
  /**
   * The pulse a run served, for its `spend.pulse_id` (§8.9). The pulse scheduler supplies it;
   * without it every spend row has none. Asked at settle, so replay gets it too.
   */
  readonly pulseOf?: (run: {
    readonly sessionId: string;
    readonly runId: string;
  }) => Promise<Result<string | null>>;
}

type Terminal = CanonicalEventOf<"terminal">;
type Binding = { readonly runId: string; readonly offset: number };
type Live = { readonly fd: number; position: number; dirty: boolean };
type SessionIngest = {
  readonly rawLog: string;
  readonly toolDir: string;
  readonly runnerId: string;
  /** Read at each segment's start: the database's prices, so an edit applies next. */
  prices?: readonly ModelRow[];
  binding?: Binding;
  live?: Live;
};
type Deferred = {
  readonly promise: Promise<RunOutcome>;
  readonly resolve: (outcome: RunOutcome) => void;
};
type Mapped = {
  readonly rows: readonly EventInsert[];
  readonly winner?: { readonly runId: string; readonly event: Terminal };
};

/** Unwinds a segment's loop; `closed` rejects with the FrmError. */
class IngestFailure extends Error {
  constructor(readonly error: FrmError) {
    super(error.message);
  }
}

const StoredBinding = z.object({
  run_id: z.string().min(1),
  offset: z.int().nonnegative(),
});
const bindingKey = (sessionId: string) => `ingest.run.${sessionId}`;

const failure = (cls: ErrorClass, message: string): FrmError => ({
  class: cls,
  message,
  retryable: false,
});
const fail = (cls: ErrorClass, message: string): Result<never> =>
  err(failure(cls, message));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function capture<T>(what: string, fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (thrown) {
    return fail("internal", `${what}: ${messageOf(thrown)}`);
  }
}

function orThrow(result: Result<unknown>): void {
  if (!result.ok) throw new IngestFailure(result.error);
}

function asTerminal(row: EventRow): Terminal | undefined {
  const e = toCanonical(row);
  return e.kind === "terminal" ? e : undefined;
}

export function createIngest(o: IngestOptions): Ingest {
  const insertEvents = o.insertEvents ?? insertEventsBatch;
  const fs = o.fs ?? nodeRawLogFs;
  const sessions = new Map<string, SessionIngest>();
  /** Runs whose first terminal is chosen: a later one is demoted, and closeRun writes none. */
  const claimed = new Set<string>();
  const terminals = new Map<string, Deferred>();
  const terminalListeners = new Set<(t: TerminalNotice) => void>();
  const commitListeners = new Set<(c: Committed) => void>();
  let broken: FrmError | undefined;
  let stopping = false;

  function fatal(error: FrmError): FrmError {
    if (broken !== undefined) return broken;
    broken = error;
    o.log.fatal(
      { error },
      "ingest failed: the raw logs hold every record, replay recovers",
    );
    o.onFatal?.(error);
    return error;
  }

  function notify<T>(listeners: ReadonlySet<(t: T) => void>, value: T): void {
    for (const fn of listeners) {
      try {
        fn(value);
      } catch (thrown) {
        o.log.error({ error: messageOf(thrown) }, "an ingest listener threw");
      }
    }
  }

  async function commit(rows: readonly EventInsert[]): Promise<Result<void>> {
    try {
      // Write-ahead: the raw log's bytes are on disk before any row that points into it.
      for (const s of sessions.values()) {
        const live = s.live;
        if (live?.dirty === true) {
          fs.fdatasync(live.fd);
          live.dirty = false;
        }
      }
      const result = await insertEvents(o.db, rows);
      if (!result.ok) return err(fatal(result.error));
      const { inserted, lastId } = result.value;
      if (lastId !== null) {
        const sessionIds = [...new Set(rows.map((r) => r.session_id))];
        notify(commitListeners, { cursor: lastId, inserted, sessionIds });
      }
      return ok(undefined);
    } catch (thrown) {
      return err(
        fatal(
          failure(
            "internal",
            `committing ${rows.length} events: ${messageOf(thrown)}`,
          ),
        ),
      );
    }
  }

  const batcher = createBatcher<EventInsert>({
    clock: o.clock,
    maxRows: o.maxRows ?? BATCH_MAX_ROWS,
    maxDelayMs: o.maxDelayMs ?? BATCH_MAX_DELAY_MS,
    commit,
  });

  function deferred(runId: string): Deferred {
    const known = terminals.get(runId);
    if (known !== undefined) return known;
    let resolve: (outcome: RunOutcome) => void = () => undefined;
    const promise = new Promise<RunOutcome>((r) => {
      resolve = r;
    });
    const made: Deferred = { promise, resolve: (outcome) => resolve(outcome) };
    terminals.set(runId, made);
    return made;
  }

  async function ensure(sessionId: string): Promise<Result<SessionIngest>> {
    const known = sessions.get(sessionId);
    if (known !== undefined) return ok(known);
    const row = await getSession(o.db, sessionId);
    if (!row.ok) return row;
    const raced = sessions.get(sessionId);
    if (raced !== undefined) return ok(raced);
    const made: SessionIngest = {
      rawLog: row.value.raw_log_path,
      toolDir: toolDir(row.value.raw_log_path),
      runnerId: row.value.runner_id,
    };
    sessions.set(sessionId, made);
    return ok(made);
  }

  /** finishRun, the spend row, terminalOf and (live only) onTerminal, after the terminal commits. */
  async function settle(
    sessionId: string,
    runId: string,
    t: Terminal,
    announce: boolean,
  ): Promise<Result<void>> {
    const { outcome, error } = t.payload;
    const finished = await finishRun(o.db, runId, {
      state: outcome,
      ...(error === undefined
        ? {}
        : { error_class: error.class, error_message: error.message }),
    });
    // A conflict: the run has its verdict already (the run timer's timeout, or a replayed settle).
    if (!finished.ok && finished.error.class !== "conflict") return finished;
    // The verdict that stands, which may predate this terminal: it decides whether spend is wasted.
    const run = finished.ok ? finished : await getRun(o.db, runId);
    if (!run.ok) return run;
    const session = await getSession(o.db, sessionId);
    if (!session.ok) return session;
    const pulse =
      o.pulseOf === undefined
        ? ok(null)
        : await o.pulseOf({ sessionId, runId });
    if (!pulse.ok) return pulse;
    const spent = await insertSpend(
      o.db,
      spendRow({
        runId,
        session: session.value,
        terminalPayload: t.payload,
        runState: run.value.state,
        pulseId: pulse.value,
      }),
    );
    if (!spent.ok) return spent;
    deferred(runId).resolve(outcome);
    if (announce) notify(terminalListeners, { sessionId, runId, outcome });
    return ok(undefined);
  }

  /** Maps one record; rows at or below `skipThrough` are already stored (replay). */
  function mapRecord(
    sessionId: string,
    s: SessionIngest,
    mapper: Mapper,
    record: LogRecord,
    skipThrough: number,
  ): Mapped {
    const events = mapper.map({
      offset: record.offset,
      bytes: record.bytes,
      ts: o.clock.now(),
      partial: record.partial,
    });
    let winner: Mapped["winner"];
    const rows = events.flatMap((mapped) => {
      const rawOffset = record.offset + mapped.ordinal;
      const b = s.binding;
      const runId =
        b !== undefined && record.offset >= b.offset && !claimed.has(b.runId)
          ? b.runId
          : undefined;
      let event: CanonicalEvent = mapped;
      if (mapped.kind === "terminal") {
        if (runId === undefined) {
          event = demote(mapped);
        } else {
          claimed.add(runId);
          winner = { runId, event: mapped };
        }
      }
      return rawOffset > skipThrough
        ? [toRow({ sessionId, runId, event, rawOffset, toolDir: s.toolDir })]
        : [];
    });
    return winner === undefined ? { rows } : { rows, winner };
  }

  async function closeOpenRun(
    sessionId: string,
    runId: string,
    c: SupervisorClose,
  ): Promise<Result<void>> {
    if (claimed.has(runId)) return ok(undefined);
    claimed.add(runId); // at once: a runner terminal arriving meanwhile is demoted
    const unclaim = <T>(r: Result<T>): Result<T> => {
      claimed.delete(runId);
      return r;
    };
    const s = await ensure(sessionId);
    if (!s.ok) return unclaim(s);
    const found = await getFirstTerminal(o.db, runId);
    if (!found.ok) return unclaim(found);
    const stored = found.value === null ? undefined : asTerminal(found.value);
    if (stored !== undefined) return settle(sessionId, runId, stored, false);
    const run = await getRun(o.db, runId);
    if (!run.ok) return unclaim(run);
    const state = run.value.state;
    const outcome: RunOutcome = state === "running" ? c.outcome : state;
    const terminal: Terminal = {
      kind: "terminal",
      ts: o.clock.now(),
      runner_type: SUPERVISOR_RUNNER_TYPE,
      text: c.message,
      payload: { outcome, error: failure(c.errorClass, c.message) },
    };
    const row = capture("storing the supervisor terminal", () =>
      toRow({
        sessionId,
        runId,
        event: terminal,
        rawOffset: -run.value.seq,
        toolDir: s.value.toolDir,
      }),
    );
    if (!row.ok) return unclaim(row);
    batcher.push([row.value]);
    const flushed = await batcher.flush();
    if (!flushed.ok) return flushed;
    return settle(sessionId, runId, terminal, true);
  }

  async function* recordsOf(a: AttachOptions): AsyncGenerator<RawRecord> {
    try {
      yield* a.adapter.records(a.handle);
    } catch (thrown) {
      o.log.error(
        { session: a.sessionId, error: messageOf(thrown) },
        "the runner's stream failed; treating it as ended",
      );
    }
  }

  async function consume(
    a: AttachOptions,
    s: SessionIngest,
    live: Live,
    mapper: Mapper,
  ): Promise<{ endOffset: number }> {
    const redact = createRedactor(a.redact ?? []);
    for await (const record of recordsOf(a)) {
      // After shutdown the fd may be closed: the record stays with the runner, which dies with us.
      if (stopping) break;
      const offset = live.position;
      // Before the append: the raw log, and so events, spills and replay, never hold a secret.
      const bytes = redact(record.bytes, record.partial);
      live.position += appendRecord(live.fd, bytes, record.partial);
      live.dirty = true;
      // Only now: a record read from the stream is in the raw log before a failure unwinds.
      if (broken !== undefined) throw new IngestFailure(broken);
      const { rows, winner } = mapRecord(
        a.sessionId,
        s,
        mapper,
        { offset, bytes, partial: record.partial },
        -1,
      );
      const full = batcher.push(rows);
      if (winner !== undefined) {
        orThrow(await batcher.flush());
        orThrow(await settle(a.sessionId, winner.runId, winner.event, true));
      } else if (full !== undefined) {
        orThrow(await full);
      }
    }
    if (!stopping) {
      orThrow(await batcher.flush());
      const open = s.binding;
      if (open !== undefined && !claimed.has(open.runId)) {
        orThrow(await closeOpenRun(a.sessionId, open.runId, a.onEof()));
      }
    }
    return { endOffset: live.position };
  }

  function closeQuietly(fd: number): void {
    try {
      closeSync(fd);
    } catch (thrown) {
      o.log.error({ error: messageOf(thrown) }, "closing a raw log failed");
    }
  }

  /** Loads the durable binding; a run whose terminal predates this segment is closed. */
  async function loadBinding(
    sessionId: string,
    s: SessionIngest,
    segmentStart: number,
  ): Promise<Result<void>> {
    const stored = await getSupervisorState(o.db, bindingKey(sessionId));
    if (!stored.ok) return stored;
    if (stored.value === null) {
      s.binding = undefined;
      return ok(undefined);
    }
    const parsed = StoredBinding.safeParse(stored.value);
    if (!parsed.success) {
      return fail(
        "internal",
        `${bindingKey(sessionId)} is corrupt: ${z.prettifyError(parsed.error)}`,
      );
    }
    const binding = { runId: parsed.data.run_id, offset: parsed.data.offset };
    s.binding = binding;
    if (claimed.has(binding.runId)) return ok(undefined);
    const found = await getFirstTerminal(o.db, binding.runId);
    if (!found.ok) return found;
    if (found.value !== null && (found.value.raw_offset ?? -1) < segmentStart) {
      claimed.add(binding.runId);
    }
    return ok(undefined);
  }

  return {
    async beginSegment(sessionId) {
      const s = await ensure(sessionId);
      if (!s.ok) return s;
      if (s.value.live !== undefined) {
        return fail("conflict", `session ${sessionId} is still attached`);
      }
      const floor = await committedEnd(o.db, sessionId);
      if (!floor.ok) return floor;
      const prices = await runnerPrices(o.db, s.value.runnerId, []);
      if (!prices.ok) return prices;
      s.value.prices = prices.value;
      const rawLog = s.value.rawLog;
      const seg = capture(`preparing ${rawLog}`, () =>
        prepareSegment(rawLog, floor.value, fs),
      );
      if (!seg.ok) return seg;
      const { start, found } = seg.value;
      if (found < floor.value) {
        o.log.warn(
          { session: sessionId, rawLog, found, committedEnd: floor.value },
          "the raw log is shorter than the offsets the database holds; padded, the segment starts past them",
        );
      }
      return ok({ offset: start });
    },

    attach(a) {
      const s = sessions.get(a.sessionId);
      if (s === undefined) {
        return fail(
          "validation",
          `beginSegment(${a.sessionId}) must come before attach`,
        );
      }
      if (s.live !== undefined)
        return fail("conflict", `session ${a.sessionId} is already attached`);
      if (stopping || broken !== undefined)
        return fail("conflict", "ingest is shut down");
      // Before the raw log opens, so an adapter that throws leaves nothing to undo.
      const mapper = capture("creating the segment's mapper", () =>
        a.adapter.createMapper({
          prices: [...(s.prices ?? []), ...a.adapter.registration().models],
        }),
      );
      if (!mapper.ok) return mapper;
      const opened = capture(`opening ${s.rawLog}`, () =>
        openAppender(s.rawLog),
      );
      if (!opened.ok) return opened;
      const { fd, size } = opened.value;
      if (size !== a.segmentOffset) {
        closeQuietly(fd);
        return fail(
          "conflict",
          `${s.rawLog} is ${size} bytes, but the segment starts at ${a.segmentOffset}`,
        );
      }
      const live: Live = { fd, position: size, dirty: false };
      s.live = live;
      const closed = consume(a, s, live, mapper.value)
        .catch((thrown: unknown) =>
          Promise.reject(
            thrown instanceof IngestFailure
              ? thrown.error
              : fatal(
                  failure(
                    "internal",
                    `ingesting ${a.sessionId}: ${messageOf(thrown)}`,
                  ),
                ),
          ),
        )
        .finally(() => {
          if (s.live !== live) return;
          s.live = undefined;
          closeQuietly(live.fd);
        });
      closed.catch(() => undefined); // the caller awaits it; this only marks it handled
      return ok({ closed });
    },

    async openRun(sessionId, runId) {
      const s = sessions.get(sessionId);
      if (s === undefined) {
        return fail(
          "validation",
          `beginSegment(${sessionId}) must come before openRun`,
        );
      }
      const open = s.binding;
      if (open !== undefined && !claimed.has(open.runId)) {
        return fail(
          "conflict",
          `run ${open.runId} of session ${sessionId} is still open`,
        );
      }
      // The binding points into the raw log, so the bytes below its offset are durable first.
      const live = s.live;
      const offset = capture(`syncing ${s.rawLog}`, () => {
        if (live !== undefined) {
          fs.fdatasync(live.fd);
          live.dirty = false;
          return live.position;
        }
        const size = statSync(s.rawLog, { throwIfNoEntry: false })?.size ?? 0;
        if (size > 0) syncRawLog(s.rawLog, fs);
        return size;
      });
      if (!offset.ok) return offset;
      // Durable first: a binding the database does not hold would misattribute events.
      const saved = await setSupervisorState(o.db, bindingKey(sessionId), {
        run_id: runId,
        offset: offset.value,
      });
      if (!saved.ok) return saved;
      // The previous run is closed and unbound now; a later closeRun of it re-reads the DB.
      if (open !== undefined) claimed.delete(open.runId);
      s.binding = { runId, offset: offset.value };
      return ok(undefined);
    },

    terminalOf(runId) {
      const d = deferred(runId);
      // Every call looks, so a failed lookup is retried by the next call and a terminal that
      // another process committed is found. A live terminal resolves it either way.
      void getFirstTerminal(o.db, runId).then((found) => {
        if (!found.ok) {
          o.log.error(
            { run: runId, error: found.error },
            "looking up a terminal failed; the next terminalOf call retries",
          );
          return;
        }
        const t = found.value === null ? undefined : asTerminal(found.value);
        if (t !== undefined) d.resolve(t.payload.outcome);
      });
      return d.promise;
    },

    async replay(sessionId, adapter) {
      const s = await ensure(sessionId);
      if (!s.ok) return s;
      const st = s.value;
      if (st.live !== undefined) {
        return fail(
          "conflict",
          `session ${sessionId} is attached; replay is for a dead process`,
        );
      }
      const row = await getSession(o.db, sessionId);
      if (!row.ok) return row;
      const from = row.value.raw_segment_offset;
      if (from === null) return ok({ endOffset: 0 });
      const bound = await loadBinding(sessionId, st, from);
      if (!bound.ok) return bound;
      const last = await getMaxRawOffset(o.db, sessionId);
      if (!last.ok) return last;
      const prices = await runnerPrices(
        o.db,
        st.runnerId,
        adapter.registration().models,
      );
      if (!prices.ok) return prices;
      const mapper = adapter.createMapper({ prices: prices.value });
      // Write-ahead holds here too: a dead process's bytes may never have reached the disk. No
      // one appends to a detached log, so one fdatasync covers every record read below.
      const synced = capture(`syncing ${st.rawLog}`, () =>
        syncRawLog(st.rawLog, fs),
      );
      if (!synced.ok) return synced;
      let end = from;
      try {
        for await (const record of readRecords(st.rawLog, from)) {
          const { rows } = mapRecord(
            sessionId,
            st,
            mapper,
            record,
            last.value ?? -1,
          );
          const full = batcher.push(rows);
          if (full !== undefined) {
            const committed = await full;
            if (!committed.ok) return committed;
          }
          end = record.offset + record.bytes.length + (record.partial ? 0 : 1);
        }
      } catch (thrown) {
        return fail("internal", `replaying ${st.rawLog}: ${messageOf(thrown)}`);
      }
      const flushed = await batcher.flush();
      if (!flushed.ok) return flushed;
      const open = st.binding;
      if (open !== undefined) {
        const found = await getFirstTerminal(o.db, open.runId);
        if (!found.ok) return found;
        const t = found.value === null ? undefined : asTerminal(found.value);
        if (t !== undefined) {
          claimed.add(open.runId);
          const settled = await settle(sessionId, open.runId, t, false);
          if (!settled.ok) return settled;
        }
      }
      return ok({ endOffset: end });
    },

    closeRun: closeOpenRun,

    onTerminal(fn) {
      terminalListeners.add(fn);
      return () => terminalListeners.delete(fn);
    },

    onCommit(fn) {
      commitListeners.add(fn);
      return () => commitListeners.delete(fn);
    },

    async shutdown() {
      stopping = true;
      const flushed = await batcher.flush();
      if (!flushed.ok) {
        o.log.error(
          { error: flushed.error },
          "events left uncommitted at shutdown; replay recovers them",
        );
      }
      for (const s of sessions.values()) {
        const live = s.live;
        if (live === undefined) continue;
        s.live = undefined;
        try {
          fs.fdatasync(live.fd);
        } catch (thrown) {
          o.log.error({ error: messageOf(thrown) }, "syncing a raw log failed");
        }
        closeQuietly(live.fd);
      }
    },
  };
}
