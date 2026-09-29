import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  TEMPLATES,
  compile,
  err,
  hashDoctrine,
  hashPrompt,
  hashToolset,
  newId,
  ok,
  sha256Hex,
  type Result,
} from "@bayon/core";
import {
  getRunSpend,
  getSession,
  listRuns,
  openDb,
  readHeartbeat,
  type Db,
  type SessionRow,
} from "@bayon/db";
import { migrateUp, seedConfig } from "@bayon/db/operator";
import {
  sessionEventsTopic,
  toolDefinitions,
  toolsetFor,
  type CommandView,
  type EventItem,
  type SpawnRequest,
} from "@bayon/proto";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { apiClient, type ApiClient } from "./api-client.js";
import {
  cursorProblems,
  missingFromSequence,
  runProblems,
  spendProblems,
} from "./assertions.js";
import {
  BOOT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  EVENTS_TIMEOUT_MS,
  EXIT_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
} from "./budget.js";
import {
  BUILD_SEQUENCE,
  GATED_SEQUENCE,
  SMOKE,
  SMOKE_TOOLS,
  agentId,
  missionTextOf,
  smokeConfig,
  spawnRequest,
  type SmokeAgent,
  type SmokeConfig,
  type SmokeMission,
} from "./config.js";
import { pollUntil, within } from "./deadline.js";
import {
  DOCTRINE,
  DOCTRINE_PATH,
  createFixtureRepo,
  mirrorProblems,
  worktreeProblems,
  type FixtureRepo,
} from "./fixture-repo.js";
import {
  follow,
  hasKind,
  ids,
  kinds,
  terminalOf,
  reached,
  type Follower,
} from "./follow.js";
import { refuse, verdict, type Harness } from "./harness.js";
import { saveMissions } from "./missions.js";
import type { Child } from "./procs.js";
import {
  entries,
  freePort,
  repoRoot,
  startApi,
  startSupervisor,
  type Entries,
} from "./stack.js";

/** Everything the phases share once the stack is up. */
export interface World {
  readonly h: Harness;
  readonly db: Db;
  readonly repo: FixtureRepo;
  readonly config: SmokeConfig;
  readonly runnerId: string;
  readonly main: Entries;
  readonly supervisor: Child;
  readonly firstApi: Child;
  readonly api: ApiClient;
  readonly port: number;
  readonly token: string;
  readonly wsUrl: string;
}

async function prepareDb(h: Harness, config: SmokeConfig): Promise<Result<Db>> {
  const opened = await openDb({
    path: join(h.home, "foreman.db"),
    clock: h.clock,
  });
  if (!opened.ok) return opened;
  h.useDb(opened.value);
  const migrated = await migrateUp(opened.value, {});
  if (!migrated.ok) return migrated;
  const seeded = await seedConfig(opened.value, config.beforeBoot);
  return seeded.ok ? ok(opened.value) : seeded;
}

/** Profiles and agents reference runners: seed them once the supervisor has registered its own. */
function seedAfterBoot(
  h: Harness,
  db: Db,
  config: SmokeConfig,
): Promise<Result<true>> {
  let last = "";
  return pollUntil(
    {
      clock: h.clock,
      timeoutMs: BOOT_TIMEOUT_MS,
      intervalMs: 100,
      what: "runner registration",
      detail: () => last,
    },
    async () => {
      const seeded = await seedConfig(db, config.afterBoot);
      if (seeded.ok) return ok(true);
      if (seeded.error.class !== "validation") return seeded;
      last = seeded.error.message;
      return ok(undefined);
    },
  );
}

/** What a smoke seeds: the operator config and the agents whose mission v1 it saves. */
export interface SetUpOptions {
  /** Default: the M0 smoke's (config.ts). */
  readonly config?: (o: {
    readonly now: number;
    readonly repo: FixtureRepo;
    readonly runnerId: string;
  }) => Promise<SmokeConfig>;
  /** Default: every M0 smoke agent, with MISSION. */
  readonly missions?: readonly SmokeMission[];
  /**
   * Runs once the database is ready, before the supervisor starts (M3: the stand-in's PATH shim;
   * its container run: the executor's registration and image). Its steps are its own; it returns
   * extra env for the supervisor alone.
   */
  readonly beforeSupervisor?: (
    h: Harness,
    db: Db,
  ) => Promise<Readonly<Record<string, string>>>;
}

/** Repo, DB, config, supervisor, then the API: the order writer discipline and boot need. */
export async function setUp(
  h: Harness,
  runnerId: string,
  o: SetUpOptions = {},
): Promise<World> {
  const main = await h.step("build outputs present", async () => {
    const root = repoRoot();
    return root.ok ? entries(root.value) : root;
  });
  const repo = await h.step(
    "fixture repo (no mirror: first use clones it)",
    async () => createFixtureRepo(join(h.home, "fixture")),
  );
  const config = await (o.config ?? smokeConfig)({
    now: h.clock.now(),
    repo,
    runnerId,
  });
  const db = await h.step("migrations and operator config", () =>
    prepareDb(h, config),
  );
  const boot = {
    home: h.home,
    env: h.io.env,
    clock: h.clock,
    onStart: (c: Child) => h.own(c),
  };
  const extraEnv =
    o.beforeSupervisor === undefined ? {} : await o.beforeSupervisor(h, db);
  // Reserved before the supervisor starts: its session runners call the API's /mcp on this port.
  const port = await freePort();
  const supervisor = await h.step("supervisor up (heartbeat)", () =>
    startSupervisor({
      ...boot,
      env: { ...boot.env, ...extraEnv },
      main: main.supervisor,
      db,
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
    }),
  );
  await h.step("agents and profiles seeded once runners registered", () =>
    seedAfterBoot(h, db, config),
  );
  const token = randomBytes(24).toString("hex");
  const api = apiClient({
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    token,
    clock: h.clock,
  });
  const firstApi = await h.step(`API up on 127.0.0.1:${port}`, () =>
    startApi({ ...boot, main: main.api, port, token, client: api }),
  );
  await saveMissions(h, api, db, o.missions);
  return {
    h,
    db,
    repo,
    config,
    runnerId,
    main,
    supervisor,
    firstApi,
    api,
    port,
    token,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
  };
}

export function commandDone(
  w: World,
  id: string,
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): Promise<Result<CommandView>> {
  let state = "not seen";
  return pollUntil(
    {
      clock: w.h.clock,
      timeoutMs,
      intervalMs: 100,
      what: `command ${id}`,
      detail: () => state,
    },
    async () => {
      const command = await w.api.command(id);
      if (!command.ok) return command;
      state = command.value.state;
      if (state === "failed")
        return err({
          ...(command.value.error ?? refuse("no error recorded")),
          message: `command ${id} failed: ${command.value.error?.message ?? "no error recorded"}`,
        });
      return ok(state === "done" ? command.value : undefined);
    },
  );
}

/** A smoke agent's session. */
const spawn = (w: World, agent: SmokeAgent): Promise<string> =>
  spawnWith(w, agent, spawnRequest(agent, w.runnerId));

/** POST /sessions with an Idempotency-Key (asked twice: one command), then the command done. */
export async function spawnWith(
  w: World,
  label: string,
  body: SpawnRequest,
): Promise<string> {
  const key = `smoke:${label}:${newId(w.h.clock.now())}`;
  const first = await w.h.step(`POST /sessions (${label})`, () =>
    w.api.spawn(body, key),
  );
  w.h.track(first.session_id);
  await w.h.step("same Idempotency-Key, same command", async () => {
    const again = await w.api.spawn(body, key);
    if (!again.ok) return again;
    const same =
      again.value.command_id === first.command_id &&
      again.value.session_id === first.session_id;
    return verdict(
      same && !again.value.created
        ? []
        : [`got ${JSON.stringify(again.value)} after ${JSON.stringify(first)}`],
    );
  });
  await w.h.step(`session ${first.session_id}: spawn command done`, () =>
    commandDone(w, first.command_id),
  );
  return first.session_id;
}

/** Waits for `done` on a follower, under a deadline, reporting what did arrive. */
export function eventsUntil(
  w: World,
  f: Follower,
  what: string,
  done: (items: readonly EventItem[]) => boolean,
  timeoutMs: number = EVENTS_TIMEOUT_MS,
): Promise<Result<readonly EventItem[]>> {
  return within(
    {
      clock: w.h.clock,
      timeoutMs,
      what,
      detail: () => `received: ${kinds(f.items()).join(", ") || "nothing"}`,
    },
    f.until(done),
  );
}

function endedOk(items: readonly EventItem[], hang: boolean): Result<void> {
  const terminal = terminalOf(items);
  if (terminal === undefined) return err(refuse("no terminal event"));
  if (terminal.payload.outcome === "ok") return ok(undefined);
  const why = hang
    ? `: the runner never finished, so the ${SMOKE.hangWallClockMs / 1_000} s run timer ended the run`
    : "";
  return err(
    refuse(
      `the run ended "${terminal.payload.outcome}" (terminal from ${terminal.runner_type}), expected "ok"${why}`,
    ),
  );
}

/** Session A: spawn, wait for `terminal` over the WS, then check worktree, events and spend. */
export async function buildSession(w: World, hang: boolean): Promise<void> {
  const id = await spawn(w, hang ? "hang" : "build");
  const events = follow(w.h.client(w.wsUrl, w.token), id);
  const timeout = hang
    ? SMOKE.hangWallClockMs + EVENTS_TIMEOUT_MS
    : EVENTS_TIMEOUT_MS;
  const items = await w.h.step(`terminal on ${sessionEventsTopic(id)}`, () =>
    eventsUntil(w, events, "a terminal event", hasKind("terminal"), timeout),
  );
  await w.h.step("the run ended ok", async () => endedOk(items, hang));
  const fixture = w.runnerId === FIXTURE_RUNNER_ID;
  await w.h.step("worktree on frm/<id> holds the README change", async () => {
    const session = await w.api.session(id);
    if (!session.ok) return session;
    const path = join(session.value.session_root, SMOKE.relPath);
    return verdict(
      worktreeProblems(path, {
        branch: `frm/${id}`,
        readmeLine: fixture ? SMOKE.readmeLine : undefined,
      }),
    );
  });
  await w.h.step("the repo's mirror was cloned on first use", async () =>
    verdict(mirrorProblems(w.repo.mirror, w.repo.origin)),
  );
  const stored = await w.h.step("GET /sessions/:id/events", () =>
    w.api.events(id),
  );
  // A runner may emit frames after its terminal (stored, per Invariant 4); wait for the WS to
  // deliver up to the last stored id before comparing, rather than truncating at the terminal.
  const storedLast = ids(stored).at(-1) ?? 0;
  await w.h.step("the WS client caught up with the DB", () =>
    eventsUntil(w, events, `id ${storedLast}`, reached(storedLast)),
  );
  await w.h.step(
    "events hold the canonical sequence; the WS delivered each id once",
    async () => {
      const expected = fixture ? BUILD_SEQUENCE : ["session_init", "terminal"];
      const missing = missingFromSequence(kinds(stored), expected);
      return verdict([
        ...(missing === undefined
          ? []
          : [`no ${missing} in order in: ${kinds(stored).join(", ")}`]),
        ...cursorProblems(ids(events.items()), ids(stored)),
      ]);
    },
  );
  await w.h.step("spend has a row with tokens", async () => {
    const runId = terminalOf(items)?.run_id;
    if (runId === undefined)
      return err(refuse("the terminal event carries no run_id"));
    const row = await getRunSpend(w.db, runId);
    if (!row.ok) return row;
    return verdict(spendProblems(row.value === null ? [] : [row.value]));
  });
  await w.h.step("run 1 recorded every input hash and the model", () =>
    runChecks(w, id),
  );
}

/** Run 1's pinned inputs (§8.1), each recomputed from what the smoke seeded and sent. */
async function runChecks(w: World, id: string): Promise<Result<void>> {
  const runs = await listRuns(w.db, id);
  if (!runs.ok) return runs;
  const run = runs.value[0];
  if (run === undefined) return err(refuse(`session ${id} has no run`));
  const session = await w.api.session(id);
  if (!session.ok) return session;
  // Run 1's prompt: the smoke's through the operator template, with the build agent's mission.
  const prompt = compile(TEMPLATES.operator, {
    task: SMOKE.prompt,
    mission: missionTextOf(agentId("build")),
  });
  if (!prompt.ok) return prompt;
  // The builder's shipped tools, mounted: toolset_hash is what the API serves it.
  const tools = toolsetFor(SMOKE.role, SMOKE_TOOLS);
  if (!tools.ok) return tools;
  return verdict(
    runProblems(run, {
      template_id: prompt.value.templateId,
      prompt_hash: await hashPrompt(prompt.value.text),
      context_hash: await sha256Hex(""), // the operator template has no volatile block
      mission_hash: w.config.missionHash,
      // The worktree is at base_sha, where DOCTRINE.md is the fixture's.
      doctrine_hash: await hashDoctrine([
        { path: DOCTRINE_PATH, content: DOCTRINE },
      ]),
      toolset_hash: await hashToolset(toolDefinitions(tools.value)),
      config_hash: session.value.config_hash,
      base_sha: w.repo.baseSha,
    }),
  );
}

export function sessionIn(
  w: World,
  id: string,
  state: string,
): Promise<Result<SessionRow>> {
  let seen = "not seen";
  return pollUntil(
    {
      clock: w.h.clock,
      timeoutMs: COMMAND_TIMEOUT_MS,
      intervalMs: 100,
      what: `session ${id} ${state}`,
      detail: () => seen,
    },
    async () => {
      const row = await getSession(w.db, id);
      if (!row.ok) return row;
      seen = row.value.state;
      return ok(seen === state ? row.value : undefined);
    },
  );
}

/**
 * Session B holds a gated run open while the API is SIGKILLed: the supervisor keeps beating and
 * the session keeps its state; after the restart, `subscribe {since: last}` plus what arrived before
 * the kill is every stored id exactly once.
 */
export async function apiRestart(w: World): Promise<void> {
  const id = await spawn(w, "gated");
  const before = follow(w.h.client(w.wsUrl, w.token), id);
  await w.h.step("gated run open: its pre-gate events arrived", () =>
    eventsUntil(
      w,
      before,
      GATED_SEQUENCE.join(", "),
      (items) =>
        missingFromSequence(kinds(items), GATED_SEQUENCE) === undefined,
    ),
  );
  const running = await w.h.step(`session ${id} running`, () =>
    sessionIn(w, id, "running"),
  );
  const last = ids(before.items()).at(-1) ?? 0;
  const beat = await w.h.step("heartbeat read", async () => {
    const read = await readHeartbeat(w.db);
    return read.ok && read.value === null ? err(refuse("no heartbeat")) : read;
  });
  await w.h.step("API SIGKILLed mid-session", () => {
    w.firstApi.signal("SIGKILL");
    return within(
      { clock: w.h.clock, timeoutMs: EXIT_TIMEOUT_MS, what: "API exit" },
      w.firstApi.exited,
    );
  });
  w.h.closeClients();
  await w.h.step("supervisor heartbeat advances without the API", () =>
    pollUntil(
      {
        clock: w.h.clock,
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        intervalMs: 200,
        what: "a newer heartbeat",
      },
      async () => {
        if (w.supervisor.status() !== undefined)
          return err(refuse("the supervisor exited"));
        const now = await readHeartbeat(w.db);
        if (!now.ok) return now;
        return ok(
          now.value !== null && now.value.at > (beat?.at ?? 0)
            ? now.value
            : undefined,
        );
      },
    ),
  );
  await w.h.step("session state unchanged while the API was down", async () => {
    const row = await getSession(w.db, id);
    return row.ok
      ? verdict(
          row.value.state === running.state
            ? []
            : [`${running.state} became ${row.value.state}`],
        )
      : row;
  });
  await w.h.step("API restarted on the same port", () =>
    startApi({
      home: w.h.home,
      env: w.h.io.env,
      clock: w.h.clock,
      onStart: (c) => w.h.own(c),
      main: w.main.api,
      port: w.port,
      token: w.token,
      client: w.api,
    }),
  );
  await resumeAndCompare(w, id, before, last);
}

/** Resubscribes since `last`, ends the gated run, and compares every id received with the DB's. */
async function resumeAndCompare(
  w: World,
  id: string,
  before: Follower,
  last: number,
): Promise<void> {
  const after = follow(w.h.client(w.wsUrl, w.token), id, last);
  const stop = await w.h.step("POST /sessions/:id/stop (graceful)", () =>
    w.api.stop(id, "graceful", `smoke:stop:${id}`),
  );
  await w.h.step("stop command done", () => commandDone(w, stop.command_id));
  await w.h.step(`terminal after subscribe {since: ${last}}`, () =>
    eventsUntil(w, after, "a terminal event", hasKind("terminal")),
  );
  const stored = await w.h.step("GET /sessions/:id/events", () =>
    w.api.events(id),
  );
  const storedLast = ids(stored).at(-1) ?? 0;
  await w.h.step("resubscribed client caught up with the DB", () =>
    eventsUntil(w, after, `id ${storedLast}`, reached(storedLast)),
  );
  await w.h.step("no gap and no duplicate across the API restart", async () =>
    verdict([
      ...(ids(after.items()).some((i) => i <= last)
        ? [`subscribe {since: ${last}} replayed an older id`]
        : []),
      ...cursorProblems(
        [...ids(before.items()), ...ids(after.items())],
        ids(stored),
      ),
    ]),
  );
}
