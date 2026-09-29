// The Jira timer under a FakeClock, no real sleeps: a full sync every
// `jira.sync_interval_ms` and a quick pass every `jira.quick_interval_ms`, one at a time, the full
// one winning when both are due; each interval read again at every wake, 0 turning each off on its
// own; a project already syncing skipped; a failed sync audited by run() while the timer carries on.
import {
  FakeClock,
  JIRA_TOKEN_SECRET,
  deltaJql,
  err,
  ok,
  type Result,
} from "@bayon/core";
import type { Db } from "@bayon/db";
import { putOperatorSettings } from "@bayon/db/api";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { JiraSyncRecord, type JiraSyncResult } from "@bayon/proto";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  FIXTURE_SITE,
  SEARCH_PATH,
  startJiraFixture,
  type JiraFixture,
} from "./fixtures.js";
import {
  JIRA_INTERVAL_KEY,
  JIRA_QUICK_INTERVAL_KEY,
  JIRA_RECHECK_MS,
  JiraScheduler,
  type JiraSchedulerDeps,
} from "./scheduler.js";
import { JiraSync, type JiraQuickResult } from "./sync.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;
const INTERVAL = 15 * MIN;
const source = (jql: string) => ({
  jira_url: FIXTURE_SITE,
  jira_email: "op@acme.test",
  jira_jql: jql,
});

let fx: JiraFixture;
beforeAll(async () => {
  fx = await startJiraFixture();
});
afterAll(async () => {
  await fx.close();
});

const lines: string[] = [];
const logger = {
  warn: (m: string) => void lines.push(m),
  error: (m: string) => void lines.push(m),
};

const opened: TempDb[] = [];
const timers: JiraScheduler[] = [];
afterEach(async () => {
  for (const t of timers.splice(0)) await t.stop();
  for (const t of opened.splice(0)) t.cleanup();
  fx.overrides.length = 0;
  fx.loginOverrides.length = 0;
  fx.queries.clear();
  fx.requests.length = 0;
  lines.length = 0;
});

interface Intervals {
  readonly full?: number;
  readonly quick?: number;
}

async function set(db: Db, { full, quick }: Intervals): Promise<void> {
  const patch = {
    ...(full === undefined ? {} : { [JIRA_INTERVAL_KEY]: full }),
    ...(quick === undefined ? {} : { [JIRA_QUICK_INTERVAL_KEY]: quick }),
  };
  if (Object.keys(patch).length > 0)
    unwrap(await putOperatorSettings(db, patch, "operator"));
}

/** Two projects with a source and one without; the intervals as given, else as migrated. */
async function fresh(
  intervals: Intervals = {},
): Promise<{ db: Db; clock: FakeClock }> {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "alpha",
          name: "alpha",
          kind: "single",
          ...source("project = A"),
        },
        { id: "beta", name: "beta", kind: "single", ...source("project = B") },
        { id: "gamma", name: "gamma", kind: "single" },
      ],
    }),
  );
  await set(t.db, intervals);
  return { db: t.db, clock };
}

/** Lets every continuation the loop has queued run: no timer, no wall-clock wait. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Moves the clock `ms` on, a minute at a time, letting the loop run at each step. */
async function pass(clock: FakeClock, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MIN) {
    await clock.advance(Math.min(MIN, left));
    await settle();
  }
}

const done = (project: string): Result<JiraSyncResult> =>
  ok({
    project,
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    parked: 0,
    ignored: 0,
    skipped: [],
    capped: false,
  });

const quickDone = (project: string, minutes: number): Result<JiraQuickResult> =>
  ok({
    project,
    window_minutes: minutes,
    matched: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    ignored: 0,
    skipped: [],
    capped: false,
  });

/**
 * A sync that records what the timer asked of it — `full:<project>` and `quick:<project>:<window>`,
 * with the minute each began — and the most passes it ever had in flight at once. `hold` keeps the
 * first full pass open until it is let go.
 */
function stubSync(
  clock: FakeClock,
  o: { running?: string; throwsFor?: string; hold?: Promise<void> } = {},
) {
  const runs: string[] = [];
  const at: number[] = [];
  let inFlight = 0;
  let most = 0;
  let held = o.hold;
  const enter = async (label: string, id: string): Promise<void> => {
    runs.push(label);
    at.push((clock.now() - T0) / MIN);
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      const h = label.startsWith("full") ? held : undefined;
      if (h !== undefined) {
        held = undefined;
        await h;
      }
      if (id === o.throwsFor) throw new Error("boom");
    } finally {
      inFlight -= 1;
    }
  };
  const sync: JiraSchedulerDeps["sync"] = {
    isRunning: (id) => id === o.running,
    run: async (id, via) => {
      expect(via).toBe("timer");
      await enter(`full:${id}`, id);
      return done(id);
    },
    quick: async (id, minutes) => {
      await enter(`quick:${id}:${minutes}`, id);
      return quickDone(id, minutes);
    },
  };
  return { sync, runs, at, most: () => most };
}

function timer(deps: Omit<JiraSchedulerDeps, "logger">): JiraScheduler {
  const t = new JiraScheduler({ ...deps, logger });
  timers.push(t);
  return t;
}

const FULL = ["full:alpha", "full:beta"];
const quick = (minutes: number) => [
  `quick:alpha:${minutes}`,
  `quick:beta:${minutes}`,
];
const times = (n: number, each: readonly string[]) =>
  Array.from({ length: n }, () => each).flat();

test("every full interval, each project with a source syncs in turn; one without never does", async () => {
  const { db, clock } = await fresh({ quick: 0 });
  const { sync, runs } = stubSync(clock);
  const t = timer({ db, clock, sync });
  t.start();
  t.start(); // a second start is the same timer
  await settle();

  await pass(clock, INTERVAL - 1);
  expect(runs).toEqual([]);
  await pass(clock, 1);
  expect(runs).toEqual(FULL);
  await pass(clock, INTERVAL);
  expect(runs).toEqual(times(2, FULL));
});

test("as migrated: a quick pass every minute over the last two, a full sync every 15, never both, never overlapping", async () => {
  const { db, clock } = await fresh();
  const s = stubSync(clock);
  timer({ db, clock, sync: s.sync }).start();
  await settle();

  await pass(clock, 30 * MIN);
  const expected = Array.from({ length: 30 }, (_, i) =>
    (i + 1) % 15 === 0 ? FULL : quick(2),
  ).flat();
  expect(s.runs).toEqual(expected);
  // Each project once a minute: minutes 1 to 30, alpha and beta in turn.
  expect(s.at).toEqual(
    Array.from({ length: 30 }, (_, i) => [i + 1, i + 1]).flat(),
  );
  expect(s.most()).toBe(1);
});

test("a full sync that runs long holds the quick pass back, and the next window covers the time it took", async () => {
  const { db, clock } = await fresh();
  let release = (): void => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = stubSync(clock, { hold });
  timer({ db, clock, sync: s.sync }).start();
  await settle();

  await pass(clock, INTERVAL);
  expect(s.runs.slice(-1)).toEqual(["full:alpha"]);
  const before = s.runs.length;
  // Three minutes with alpha's full sync in flight: no quick pass starts beside it.
  await pass(clock, 3 * MIN);
  expect(s.runs).toHaveLength(before);

  release();
  await settle();
  await clock.advance(0);
  await settle();
  // Beta's full sync, then at once a quick pass over the 3 minutes since the full one began, + 1.
  expect(s.runs.slice(before)).toEqual(["full:beta", ...quick(4)]);
  await pass(clock, MIN);
  expect(s.runs.slice(-2)).toEqual(quick(2));
  expect(s.most()).toBe(1);
});

test("0 turns the quick pass off on its own: full syncs only", async () => {
  const { db, clock } = await fresh({ quick: 0 });
  const s = stubSync(clock);
  timer({ db, clock, sync: s.sync }).start();
  await settle();
  await pass(clock, 30 * MIN);
  expect(s.runs).toEqual(times(2, FULL));
  expect(s.at).toEqual([15, 15, 30, 30]);
});

test("0 turns the full sync off on its own: quick passes only, every minute", async () => {
  const { db, clock } = await fresh({ full: 0 });
  const s = stubSync(clock);
  timer({ db, clock, sync: s.sync }).start();
  await settle();
  await pass(clock, 20 * MIN);
  expect(s.runs).toEqual(times(20, quick(2)));
});

test("the intervals are read again at every wake: off, on again within a minute, a new cadence at once", async () => {
  const { db, clock } = await fresh({ quick: 0 });
  const s = stubSync(clock);
  timer({ db, clock, sync: s.sync }).start();
  await settle();

  // Turned off while the timer waits: the wake-up reads it again and skips the tick.
  await set(db, { full: 0 });
  await pass(clock, INTERVAL);
  await pass(clock, 30 * JIRA_RECHECK_MS);
  expect(s.runs).toEqual([]);

  // A quick pass turned on: the next look runs one, over all 46 minutes since the timer began.
  await set(db, { quick: 5 * MIN });
  await pass(clock, JIRA_RECHECK_MS);
  expect(s.runs).toEqual(quick(47));
  await pass(clock, 4 * MIN);
  expect(s.runs).toHaveLength(2);
  await pass(clock, MIN);
  expect(s.runs.slice(2)).toEqual(quick(6));

  // The full sync on again, every minute: both are due each minute, and the full one always wins.
  await set(db, { full: MIN, quick: MIN });
  await pass(clock, JIRA_RECHECK_MS);
  expect(s.runs.slice(4)).toEqual(FULL);
  await pass(clock, 3 * MIN);
  expect(s.runs.slice(6)).toEqual(times(3, FULL));
});

test("an unreadable interval is logged and read as off; the other cadence carries on", async () => {
  const { db, clock } = await fresh();
  unwrap(
    await seedRows(db, {
      settings: [
        { key: JIRA_INTERVAL_KEY, value_json: '"soon"', updated_at: T0 },
      ],
    }),
  );
  const s = stubSync(clock);
  timer({ db, clock, sync: s.sync }).start();
  await settle();
  await pass(clock, 16 * MIN);
  expect(s.runs).toEqual(times(16, quick(2)));
  expect(lines).toContain(
    `${JIRA_INTERVAL_KEY} is unreadable; that Jira timer is off until it is set`,
  );
  expect(lines.some((l) => l.startsWith(JIRA_QUICK_INTERVAL_KEY))).toBe(false);
});

test("stop() ends the timer: nothing runs after it", async () => {
  const { db, clock } = await fresh();
  const { sync, runs } = stubSync(clock);
  const t = timer({ db, clock, sync });
  t.start();
  await settle();
  await t.stop();
  await pass(clock, INTERVAL * 2);
  expect(runs).toEqual([]);
});

test("a project already syncing (its button) is skipped for either pass; a sync that throws is logged, and the next goes on", async () => {
  const { db, clock } = await fresh();
  const busy = stubSync(clock, { running: "alpha" });
  const t = timer({ db, clock, sync: busy.sync });
  await t.tick();
  await t.quickTick(2);
  expect(busy.runs).toEqual(["full:beta", "quick:beta:2"]);

  const throwing = stubSync(clock, { throwsFor: "alpha" });
  const u = timer({ db, clock, sync: throwing.sync });
  await expect(u.tick()).resolves.toBeUndefined();
  await expect(u.quickTick(2)).resolves.toBeUndefined();
  expect(throwing.runs).toEqual([...FULL, ...quick(2)]);
  expect(
    lines.filter((l) => l.includes("sync of alpha threw: boom")),
  ).toHaveLength(2);
});

const realSync = (db: Db) =>
  new JiraSync({
    db,
    token: {
      kind: "keychain",
      keychain: { service: "foreman-0123456789ab", owner: false },
      secrets: {
        get: async (name: string) =>
          name === JIRA_TOKEN_SECRET
            ? ok("timer-token-1234")
            : err({ class: "not_found", message: name, retryable: false }),
      },
    },
    fetch: fx.fetchVia(),
    timeoutMs: 5_000,
    logger,
  });

test("the timer's quick pass asks Jira for each project's query over its window, and audits nothing when nothing changed", async () => {
  const { db, clock } = await fresh();
  timer({ db, clock, sync: realSync(db) }).start();
  await settle();
  await clock.advance(MIN);
  const searched = () =>
    fx.requests
      .filter((r) => r.path === SEARCH_PATH)
      .map((r) => r.query.get("jql"));
  // Real requests to the fixture: wait for both, however long the loopback takes.
  await expect.poll(searched).toHaveLength(2);
  expect(searched()).toEqual([
    deltaJql("project = A", 2),
    deltaJql("project = B", 2),
  ]);
  await settle();
  expect(unwrap(await listAudit(db))).toEqual([]);
});

test("a failing sync is audited by run(), never thrown out of the timer; the other project still syncs", async () => {
  const { db, clock } = await fresh({ quick: 0 });
  fx.queries.set("project = A", []);
  fx.queries.set("project = B", []);
  fx.overrides.push({ status: 500, body: "" });
  timer({ db, clock, sync: realSync(db) }).start();
  await settle();
  await pass(clock, INTERVAL);
  // Real requests to the fixture: wait for both rows, however long the loopback takes.
  await expect
    .poll(async () =>
      unwrap(await listAudit(db)).filter((a) => a.action === "jira.sync"),
    )
    .toHaveLength(2);
  const rows = unwrap(await listAudit(db))
    .filter((a) => a.action === "jira.sync")
    .map((a) => [
      a.target_id,
      a.workspace_id,
      JiraSyncRecord.parse(JSON.parse(a.payload_json ?? "null")),
    ]);
  expect(rows).toEqual([
    [
      "alpha",
      "alpha",
      expect.objectContaining({
        via: "timer",
        ok: false,
        error: expect.objectContaining({
          class: "runner_error",
          retryable: true,
        }),
      }),
    ],
    ["beta", "beta", expect.objectContaining({ via: "timer", ok: true })],
  ]);
});
