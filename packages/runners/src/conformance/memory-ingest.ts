// The offline reference ingest: the supervisor's ingest laws in memory, for
// the suite's self-check. Never certifiable (`source: 'reference'`); its tests replay the named
// cases of apps/supervisor/src/ingest/ingest.test.ts. Runner-neutral.
import {
  err,
  ok,
  type CanonicalEvent,
  type Clock,
  type FrmError,
  type Result,
  type RunOutcome,
} from "@bayon/core";
import { asFrmError, frmError } from "../errors.js";
import type { AttachSpec, IngestPort, RunClose, StoredEvent } from "./types.js";

const REDACTED = "[redacted]";
/** As the supervisor's redactor: shorter values are too likely to occur in ordinary text. */
const MIN_REDACT_LENGTH = 16;

type Listener = (sessionId: string, e: StoredEvent) => void;

interface RunState {
  readonly sessionId: string;
  terminal: boolean;
  readonly outcome: PromiseWithResolvers<RunOutcome>;
}

interface SessionState {
  readonly events: StoredEvent[];
  readonly raw: Uint8Array[];
  runId: string | undefined;
  ended: Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const NEWLINE = new Uint8Array([0x0a]);

/** Each value, and its JSON-escaped form, replaced before the raw append (Invariant 11). */
function redactor(
  values: readonly string[],
): (bytes: Uint8Array) => Uint8Array {
  const forms = values
    .filter((v) => v.length >= MIN_REDACT_LENGTH)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)])
    .toSorted((a, b) => b.length - a.length);
  if (forms.length === 0) return (bytes) => bytes;
  return (bytes) => {
    const text = decoder.decode(bytes);
    const redacted = forms.reduce((t, f) => t.split(f).join(REDACTED), text);
    return redacted === text ? bytes : encoder.encode(redacted);
  };
}

/** A late or unbound terminal, kept as the supervisor keeps it: `runner_native`, `demoted_kind`. */
function demote(e: CanonicalEvent): CanonicalEvent {
  return {
    kind: "runner_native",
    ts: e.ts,
    runner_type: e.runner_type,
    ...(e.text === undefined ? {} : { text: e.text }),
    payload: { raw: e.payload, demoted_kind: e.kind },
  };
}

export function createMemoryIngest(o: { readonly clock: Clock }): IngestPort {
  const sessions = new Map<string, SessionState>();
  const runs = new Map<string, RunState>();
  let listeners: readonly Listener[] = [];
  let seq = 0;
  let failure: FrmError | null = null;

  const session = (id: string): SessionState => {
    const found = sessions.get(id);
    if (found !== undefined) return found;
    const created: SessionState = {
      events: [],
      raw: [],
      runId: undefined,
      ended: Promise.resolve(),
    };
    sessions.set(id, created);
    return created;
  };

  const run = (runId: string, sessionId: string): RunState => {
    const found = runs.get(runId);
    if (found !== undefined) return found;
    const created: RunState = {
      sessionId,
      terminal: false,
      outcome: Promise.withResolvers<RunOutcome>(),
    };
    runs.set(runId, created);
    return created;
  };

  function store(
    sessionId: string,
    runId: string | undefined,
    e: CanonicalEvent,
    source: StoredEvent["source"],
  ): void {
    const s = session(sessionId);
    let event = e;
    if (e.kind === "terminal") {
      const r = runId === undefined ? undefined : runs.get(runId);
      if (r === undefined || r.terminal) {
        event = demote(e); // the first terminal of a run wins
      } else {
        r.terminal = true;
        r.outcome.resolve(e.payload.outcome);
      }
    }
    seq += 1;
    const stored: StoredEvent = {
      ...event,
      ...(runId === undefined ? {} : { run_id: runId }),
      source,
      seq,
    };
    s.events.push(stored);
    for (const listener of listeners) listener(sessionId, stored);
  }

  async function closeRun(
    sessionId: string,
    runId: string,
    c: RunClose,
  ): Promise<Result<void>> {
    const r = runs.get(runId);
    if (r === undefined || r.sessionId !== sessionId) {
      return err(frmError("not_found", `no run ${runId} on ${sessionId}`));
    }
    if (r.terminal) return ok(undefined);
    store(
      sessionId,
      runId,
      {
        kind: "terminal",
        ts: o.clock.now(),
        runner_type: "supervisor",
        payload: {
          outcome: c.outcome,
          error: { class: c.errorClass, message: c.message, retryable: false },
        },
      },
      "supervisor",
    );
    return ok(undefined);
  }

  async function read(a: AttachSpec, s: SessionState): Promise<void> {
    const mapper = a.adapter.createMapper({
      prices: a.adapter.registration().models,
    });
    const redact = redactor(a.redact ?? []);
    let offset = s.raw.reduce((n, b) => n + b.length, 0);
    try {
      for await (const record of a.adapter.records(a.handle)) {
        const bytes = redact(record.bytes);
        s.raw.push(bytes, NEWLINE);
        const events = mapper.map({
          offset,
          bytes,
          ts: o.clock.now(),
          partial: record.partial,
        });
        offset += bytes.length + 1;
        for (const { ordinal: _ordinal, ...event } of events) {
          void _ordinal;
          store(a.sessionId, s.runId, event, "runner");
        }
      }
    } catch (e) {
      failure = asFrmError(e, "internal", "ingest failed");
    }
    const open = s.runId === undefined ? undefined : runs.get(s.runId);
    if (s.runId !== undefined && open !== undefined && !open.terminal) {
      await closeRun(a.sessionId, s.runId, {
        outcome: "failed",
        errorClass: "runner_exited_without_terminal",
        message: "the runner exited without a terminal event",
      });
    }
  }

  return {
    source: "reference",

    async attach(a) {
      const s = session(a.sessionId);
      s.ended = read(a, s);
      return ok(undefined);
    },

    async openRun(sessionId, runId) {
      const s = session(sessionId);
      const open = s.runId === undefined ? undefined : runs.get(s.runId);
      if (open !== undefined && !open.terminal) {
        return err(
          frmError(
            "conflict",
            `run ${s.runId ?? ""} is still open on ${sessionId}`,
          ),
        );
      }
      s.runId = runId;
      run(runId, sessionId);
      return ok(undefined);
    },

    events: async (sessionId) => [...session(sessionId).events],

    async raw(sessionId) {
      const parts = session(sessionId).raw;
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((at, p) => {
        out.set(p, at);
        return at + p.length;
      }, 0);
      return out;
    },

    terminalOf: (runId) => {
      const r = runs.get(runId);
      return r === undefined ? Promise.resolve("failed") : r.outcome.promise;
    },

    closeRun,

    ended: (sessionId) => session(sessionId).ended,

    onEvent(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },

    fatal: () => failure,
  };
}
