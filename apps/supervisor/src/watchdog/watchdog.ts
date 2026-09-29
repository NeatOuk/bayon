// The watchdog (§13.2; the design). One component with one serial queue: every
// check, periodic or event-driven, runs on it, so two checks of one ticket never race. It never
// awaits a session-queue op (MEDIUM-1): an earlier change awaits circuit.check() from inside one.
//
// - tick(): reconciler step 8. Each rule is its own queue op (N4): silence, ceilings, storm,
//   circuit, split, disk. Probes and statfs run outside the queue and apply in an op.
// - the stuck rule (§3.1): its own timer, every lifecycle.kill_grace_ms, calling only executor
//   methods; the reconciler pass could not reach a stuck session (its step 1 awaits the queues
//   the stuck ops hold).
// - events: a run that ended not ok and a session's end queue the circuit for its ticket; a
//   pending hand-off queues the split question. Coalesced per ticket (LOW-4).
import {
  ADMISSION_SETTING_KEYS,
  WATCHDOG_SETTING_KEYS,
  err,
  readAdmissionSettings,
  readWatchdogSettings,
  type AdmissionSettings,
  type Result,
  type RunOutcome,
  type WatchdogSettings,
} from "@bayon/core";
import { getSession, getSettings } from "@bayon/db";
import type { HandoffPending, SessionEnded } from "../lifecycle/context.js";
import {
  checkCircuit,
  evaluateCircuit,
  type CircuitBreaker,
  type CircuitSettings,
} from "./circuit.js";
import { diskRule, lowestFreePct, type DiskMemory } from "./disk.js";
import type { WatchdogDeps } from "./ports.js";
import { applyProbes, probeSilent, type SilenceMemory } from "./silence.js";
import { splitRule } from "./split.js";
import { stormRule } from "./storm.js";
import { newStuckMemory, releaseStuck } from "./stuck.js";

export type { CircuitBreaker, CircuitVerdict } from "./circuit.js";

export interface Watchdog {
  /** Reconciler step 8: the periodic rules, each its own op; resolves when all have run. */
  tick(): Promise<void>;
  /** The stuck rule's op, as its timer runs it (exposed for tests). */
  releaseStuck(): Promise<void>;
  /** A run's terminal committed: a run that did not end ok queues its ticket's circuit (§1). */
  runEnded(sessionId: string, outcome: RunOutcome): void;
  sessionEnded(e: SessionEnded): void;
  handoffPending(e: HandoffPending): void;
  readonly circuit: CircuitBreaker;
  /** single-flight early retention (main.ts wires it after the backups). */
  useRetention(fn: (reason: string) => Promise<void>): void;
  /** Starts the stuck timer. */
  start(): void;
  /** Stops the timer and waits for the queue. Idempotent. */
  stop(): Promise<void>;
  /** Settles once every queued op has run (tests). */
  settled(): Promise<void>;
}

interface Settings {
  readonly watchdog: WatchdogSettings;
  readonly admission: AdmissionSettings;
}

const SETTING_KEYS = [
  ...Object.values(WATCHDOG_SETTING_KEYS),
  ...Object.values(ADMISSION_SETTING_KEYS),
];

async function readSettings(d: WatchdogDeps): Promise<Result<Settings>> {
  const rows = await getSettings(d.db, SETTING_KEYS);
  if (!rows.ok) return rows;
  const watchdog = readWatchdogSettings(rows.value);
  if (!watchdog.ok) return watchdog;
  const admission = readAdmissionSettings(rows.value);
  return admission.ok
    ? {
        ok: true,
        value: { watchdog: watchdog.value, admission: admission.value },
      }
    : admission;
}

const circuitOf = (s: Settings): CircuitSettings => ({
  threshold: s.watchdog.circuitFailedRuns,
  storm: s.admission.retryStorm,
});

export function createWatchdog(d: WatchdogDeps): Watchdog {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(what: string, op: () => Promise<T>): Promise<T> => {
    const run = tail.then(op);
    tail = run.catch((e: unknown) => {
      d.log.error({ err: String(e) }, `watchdog: ${what} failed`);
    });
    return run;
  };
  const silence: SilenceMemory = { probedAt: new Map() };
  const disk: DiskMemory = { lastDay: null };
  const stuck = newStuckMemory();
  const circuitQueued = new Set<string>();
  const splitQueued = new Set<string>();
  let retention: ((reason: string) => Promise<void>) | undefined;
  const timer = new AbortController();
  let started = false;

  /** A rule's op; its failure is logged and never stops the next. */
  const rule = (what: string, op: () => Promise<void>): Promise<void> =>
    enqueue(what, op).catch(() => undefined);

  const withSettings = async <T>(
    op: (s: Settings) => Promise<Result<T>>,
  ): Promise<Result<T>> => {
    const s = await readSettings(d);
    return s.ok ? op(s.value) : s;
  };

  const queueCircuit = (ticketId: string): void => {
    if (circuitQueued.has(ticketId)) return;
    circuitQueued.add(ticketId);
    void rule("circuit event", async () => {
      circuitQueued.delete(ticketId);
      const done = await withSettings((s) =>
        evaluateCircuit(d, circuitOf(s), ticketId),
      );
      if (!done.ok) d.log.error({ ticketId, error: done.error }, "circuit");
    });
  };

  const queueSplit = (ticketId: string): void => {
    if (splitQueued.has(ticketId)) return;
    splitQueued.add(ticketId);
    void rule("split event", async () => {
      splitQueued.delete(ticketId);
      const s = await readSettings(d);
      if (!s.ok) {
        d.log.error({ error: s.error }, "watchdog settings");
        return;
      }
      await splitRule(d, s.value.watchdog.splitHandoffs, ticketId);
    });
  };

  const stuckOp = (): Promise<void> =>
    rule("stuck", () =>
      releaseStuck({
        candidates: d.candidates,
        memory: stuck,
        now: d.clock.now(),
        graceMs: d.killGraceMs(),
        log: d.log,
      }),
    );

  const loop = (): void => {
    d.clock.after(d.killGraceMs(), timer.signal).then(
      async () => {
        await stuckOp();
        loop();
      },
      () => undefined, // stopped
    );
  };

  return {
    async tick() {
      const settings = await readSettings(d);
      if (!settings.ok) {
        d.log.error(
          { error: settings.error },
          "watchdog: its settings cannot be read; every rule skips this tick",
        );
        return;
      }
      const s = settings.value;
      // Probes and statfs outside the queue (N4); their results apply in queue ops.
      const [probes, freePct] = await Promise.all([
        probeSilent(d, s.watchdog.silentMs, silence),
        lowestFreePct(d),
      ]);
      await Promise.all([
        rule("silence", async () => applyProbes(d, probes, silence)),
        rule("ceilings", async () => d.checkCeilings()),
        rule("storm", () => stormRule(d, s.admission.retryStorm)),
        rule("circuit", async () => {
          const done = await evaluateCircuit(d, circuitOf(s));
          if (!done.ok) d.log.error({ error: done.error }, "circuit sweep");
        }),
        rule("split", () => splitRule(d, s.watchdog.splitHandoffs)),
        rule("disk", () =>
          diskRule(d, freePct, s.watchdog.diskMinFreePct, disk, retention),
        ),
      ]);
    },
    releaseStuck: stuckOp,
    runEnded(sessionId, outcome) {
      // An ok run is no failure: it queues nothing (the sweep still sees its reset, §5.2).
      if (outcome === "ok") return;
      void getSession(d.db, sessionId).then((s) => {
        if (s.ok && s.value.ticket_id !== null) queueCircuit(s.value.ticket_id);
      });
    },
    sessionEnded(e) {
      if (e.ticketId !== null) queueCircuit(e.ticketId);
    },
    handoffPending(e) {
      queueSplit(e.ticketId);
    },
    circuit: {
      check: (ticketId) =>
        enqueue("circuit check", () =>
          withSettings((s) => checkCircuit(d, circuitOf(s), ticketId)),
        ).catch((e: unknown) =>
          err({
            class: "internal",
            message: `circuit check failed: ${String(e)}`,
            retryable: true,
          }),
        ),
    },
    useRetention(fn) {
      retention = fn;
    },
    start() {
      if (started) return;
      started = true;
      loop();
    },
    async stop() {
      timer.abort();
      await tail;
    },
    async settled() {
      let seen: Promise<unknown>;
      do {
        seen = tail;
        await seen;
      } while (seen !== tail);
    },
  };
}
