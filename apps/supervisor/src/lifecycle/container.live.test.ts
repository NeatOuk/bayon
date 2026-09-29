// Container placement against the real docker host over ssh. Skipped unless
// FRM_CONTAINER=1 (after `pnpm -w build`: the container runs the compiled fixture program):
//   FRM_CONTAINER=1 pnpm exec vitest run apps/supervisor/src/lifecycle/container.live.test.ts
// FRM_CONTAINER_HOST (user@host, required), FRM_CONTAINER_KEY (a 0600 key,
// default ~/.ssh/id_ed25519); the host key comes from the operator's ~/.ssh/known_hosts, never a
// scan. The executor is registered by the operator's CLI, `frm executor add … --untrusted-roles
// investigator,reviewer` then `frm executor image` (FROM the host's node:22-bookworm-slim, git
// added, labelled frm.managed=1 + frm.executor=<this run's id>), and built from its row. The
// host is shared: every object this run makes is labelled and removed by label; unlabelled ones are
// only listed, never touched. Pin refs in the executor's mirror are dropped once their gate or
// session is finished, and kept otherwise.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeClock, UNTRUSTED_ROLES_KEY, systemClock } from "@bayon/core";
import {
  getExecutor,
  getSession,
  getSettings,
  listSessionsInStates,
  type GateRow,
} from "@bayon/db";
import {
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ContainerExecutorConfig,
  LocalExecutor,
  SlotCounter,
  type Executor,
} from "@bayon/executors";
import {
  createFixtureAdapter,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPlacement, type Placement } from "../placement.js";
import { certifyPair } from "./testing/certify.js";
import type { Log } from "./context.js";
import type { SessionSpawnPayload } from "./payloads.js";
import {
  CMD,
  EXECUTOR_ID,
  lifecycleRows,
  spawnPayload,
  startLifecycle,
  tempHome,
  type Started,
} from "./testing/fixtures.js";

const LIVE = process.env["FRM_CONTAINER"] === "1";
const [USER = "", HOST = ""] = (process.env["FRM_CONTAINER_HOST"] ?? "").split(
  "@",
);
if (LIVE && (USER === "" || HOST === ""))
  throw new Error("FRM_CONTAINER=1 needs FRM_CONTAINER_HOST=user@host");
const KEY =
  process.env["FRM_CONTAINER_KEY"] ?? join(homedir(), ".ssh", "id_ed25519");
const BASE = "node:22-bookworm-slim";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RUN = [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join("");
const ID = `ctr-g${randomBytes(4).toString("hex")}`;
const ROOT = `/home/${USER}/frm/test/${RUN}`;
const ROOT_GUARD = new RegExp(
  `^/home/${USER}/frm/test/[0-9A-HJKMNP-TV-Z]{26}$`,
);
const LABELS = `--filter label=frm.managed=1 --filter label=frm.executor=${ID}`;
const FIXTURE_DIR = `${ROOT}/mirror/fixture`;
const MINUTE = 60_000;
const WAIT = { timeout: 90_000, interval: 250 };
const TURN = { kind: "turn_start", runner_type: "fixture.step", payload: {} };
const SCRIPT: FixtureScriptInput = { runs: [{ events: [TURN] }] };
/** Evidence lines: printed, and appended to $FRM_LIVE_REPORT when set. */
const REPORT = process.env["FRM_LIVE_REPORT"];
const note = (line: string): void => {
  console.log(line);
  if (REPORT !== undefined) appendFileSync(REPORT, `${line}\n`);
};
const log: Log = {
  info: () => undefined,
  warn: (obj, msg) => note(`warn: ${msg} ${JSON.stringify(obj)}`),
  error: (obj, msg) => note(`error: ${msg} ${JSON.stringify(obj)}`),
};

interface World {
  readonly home: ReturnType<typeof tempHome>;
  readonly t: TempDb;
  readonly started: Started;
  readonly placement: Placement;
  readonly local: LocalExecutor;
  readonly executor: Executor;
  readonly image: string;
  readonly unlabelledBefore: readonly string[];
}
let world: World | undefined;
let knownHosts = "";
const need = (): World => {
  if (world === undefined) throw new Error("the live setup did not finish");
  return world;
};

/** A command of this test's own on the docker host: its own connection, never the executor's. */
const remote = (command: string, input?: Buffer): string =>
  execFileSync(
    "ssh",
    [
      "-F",
      "none",
      "-o",
      "BatchMode=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "StrictHostKeyChecking=yes",
      "-i",
      KEY,
      `${USER}@${HOST}`,
      command,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    },
  );
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
/** Containers with no frm.managed label: listed, never touched. */
const unlabelled = (): string[] =>
  lines(
    remote(
      `docker ps -a --no-trunc --format '{{.ID}} {{.Label "frm.managed"}}'`,
    ),
  )
    .filter((l) => l.split(" ").length === 1)
    .map((l) => l.split(" ")[0] ?? "");
const sessionContainers = (sid: string): string[] =>
  lines(remote(`docker ps -aq ${LABELS} --filter label=frm.session=${sid}`));

/** The compiled fixture program and its one dependency, as a tar the container can run. */
function fixtureTar(stage: string): Buffer {
  mkdirSync(join(stage, "node_modules"), { recursive: true });
  cpSync(
    join(REPO_ROOT, "packages/runners/dist/adapters/fixture/program.js"),
    join(stage, "program.js"),
  );
  writeFileSync(join(stage, "package.json"), '{"type":"module"}\n');
  cpSync(
    join(REPO_ROOT, "packages/runners/node_modules/zod"),
    join(stage, "node_modules", "zod"),
    { recursive: true, dereference: true },
  );
  return execFileSync(
    "tar",
    ["--no-xattrs", "-c", "-f", "-", "-C", stage, "."],
    {
      env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** The operator's CLI (tools/frm, built), on this run's FRM_HOME and database. */
const frm = (home: string, db: string, args: readonly string[]): string =>
  execFileSync(
    process.execPath,
    [join(REPO_ROOT, "tools/frm/dist/main.js"), ...args],
    {
      encoding: "utf8",
      env: { ...process.env, FRM_HOME: home, FRM_DB: db },
    },
  );

async function setup(): Promise<World> {
  const home = tempHome("frm-g48-");
  const t = unwrap(await tempDb(new FakeClock(Date.now())));
  // The seam --m3 container run uses: the operator registers the executor, pins its
  // host key from ~/.ssh/known_hosts, and opts reviewers into the trust rule explicitly.
  const added = frm(home.path, t.path, [
    "executor",
    "add",
    ID,
    "--host",
    HOST,
    "--user",
    USER,
    "--identity-ref",
    `file:${KEY}`,
    "--remote-root",
    ROOT,
    "--network",
    "none",
    "--min-free-pct",
    "5",
    "--known-hosts",
    join(homedir(), ".ssh", "known_hosts"),
    "--untrusted-roles",
    "investigator,reviewer",
  ]);
  note(`frm executor add: ${lines(added).join(" | ")}`);
  knownHosts = join(home.path, "executors", ID, "known_hosts");
  const unlabelledBefore = unlabelled();
  // The image: FROM the base, git added, labelled as this run's (build), its tag in the row.
  const imaged = frm(home.path, t.path, ["executor", "image", ID]);
  note(`frm executor image: ${lines(imaged).join(" | ")}`);
  const row = unwrap(await getExecutor(t.db, ID));
  const image = ContainerExecutorConfig.parse(
    JSON.parse(row.config_json),
  ).image;
  const roles = unwrap(await getSettings(t.db, [UNTRUSTED_ROLES_KEY])).get(
    UNTRUSTED_ROLES_KEY,
  );
  note(`image ${image}; ${UNTRUSTED_ROLES_KEY} = ${JSON.stringify(roles)}`);
  const src = join(home.path, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "DOCTRINE.md"), "# rules\n");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const mirror = join(home.path, "mirror.git");
  git(home.path, "clone", "-q", "--bare", src, mirror);
  // A second repo, the dep of the multi-repo session.
  const src2 = join(home.path, "src2");
  mkdirSync(src2);
  git(src2, "init", "-q", "-b", "main");
  writeFileSync(join(src2, "LIB.md"), "lib\n");
  git(src2, "add", ".");
  git(src2, "commit", "-q", "-m", "lib");
  const mirror2 = join(home.path, "mirror2.git");
  git(home.path, "clone", "-q", "--bare", src2, mirror2);
  const rows = lifecycleRows({ script: SCRIPT });
  unwrap(
    await seedRows(t.db, {
      ...rows,
      // Local is trusted, as boot upserts it (rule 4); the container's row is frm's.
      executors: rows.executors.map((e) => ({ ...e, trust: "trusted" })),
      repos: [
        {
          id: "repo_1",
          name: "repo_1",
          origin_url: null,
          mirror_path: mirror,
          doctrine_paths_json: '["DOCTRINE.md"]',
        },
        {
          id: "repo_2",
          name: "repo_2",
          origin_url: null,
          mirror_path: mirror2,
          doctrine_paths_json: "[]",
        },
      ],
      workspaces: [
        { id: "ws", name: "ws", kind: "single" },
        { id: "wm", name: "wm", kind: "multi" },
      ],
      workspace_repos: [
        {
          workspace_id: "ws",
          repo_id: "repo_1",
          rel_path: "repo",
          role: "primary",
        },
        {
          workspace_id: "wm",
          repo_id: "repo_1",
          rel_path: "repo",
          role: "primary",
        },
        { workspace_id: "wm", repo_id: "repo_2", rel_path: "lib", role: "dep" },
      ],
    }),
  );
  const localSlots = new SlotCounter(4);
  const local = new LocalExecutor({ id: EXECUTOR_ID, slots: localSlots });
  // Executors from their rows, as the daemon: the lifecycle loads them at boot.
  const placement = createPlacement({
    frmHome: home.path,
    mcpUrl: "http://127.0.0.1:3010/mcp",
    local: { executor: local, slots: localSlots },
    egressHosts: [],
    log,
  });
  const adapter = createFixtureAdapter({
    clock: systemClock,
    command: ["node", `${FIXTURE_DIR}/program.js`],
  });
  const started = await startLifecycle({
    db: t.db,
    clock: systemClock,
    frmHome: home.path,
    executor: local,
    slots: localSlots,
    loadExecutors: (db) => placement.load(db),
    adapter,
  });
  const executor = placement.loaded().get(ID)?.executor;
  if (executor === undefined) {
    throw new Error(`${ID} was not built from its row`);
  }
  // Admission refuses an uncertified pair (require_certified=1), and the rig certifies
  // only the executors it is handed: the container, loaded from its row, is certified here.
  await certifyPair(t.db, {
    runnerId: adapter.id,
    runnerVersion: adapter.registration().runner.versionDetected,
    caps: adapter.caps(),
    executorId: ID,
    executorKind: "container",
    at: Date.now(),
  });
  // The fixture program, by this test's own connection, into this run's mirror directory (which
  // every session container mounts read-only at its host path).
  const tar = fixtureTar(join(home.path, "fixture"));
  remote(`mkdir -p ${FIXTURE_DIR} && tar -x -f - -C ${FIXTURE_DIR}`, tar);
  note(`fixture: ${tar.length} bytes into ${FIXTURE_DIR}`);
  return {
    home,
    t,
    started,
    placement,
    local,
    executor,
    image,
    unlabelledBefore,
  };
}

describe.skipIf(!LIVE)(`container placement on ${HOST}`, () => {
  beforeAll(async () => {
    world = await setup();
  }, 15 * MINUTE);

  afterAll(async () => {
    if (world !== undefined) {
      const w = world;
      await w.started.lifecycle.shutdown();
      const live = await listSessionsInStates(w.t.db, ["idle", "running"]);
      for (const s of live.ok ? live.value : []) {
        if (s.executor_ref === null) continue;
        const owner = s.executor_id === ID ? w.executor : w.local;
        await owner.cleanup(s.executor_ref, "hard").catch(() => undefined);
      }
      await w.placement.close();
    }
    remote(
      [
        `docker ps -aq ${LABELS} | xargs -r docker rm -f >/dev/null`,
        `docker ps -aq --filter label=frm.test=${RUN} | xargs -r docker rm -f >/dev/null`,
        `docker image ls -q ${LABELS} | xargs -r docker image rm >/dev/null`,
      ].join("\n"),
    );
    if (ROOT_GUARD.test(ROOT)) remote(`rm -rf ${ROOT}`);
    const left = remote(
      [
        `echo containers $(docker ps -aq ${LABELS} | wc -l)`,
        `echo decoys $(docker ps -aq --filter label=frm.test=${RUN} | wc -l)`,
        `echo images $(docker image ls -q ${LABELS} | wc -l)`,
        `echo root $(test -e ${ROOT} && echo left || echo gone)`,
      ].join("\n"),
    ).trim();
    note(`teardown: ${ID}: ${left.replaceAll("\n", ", ")}`);
    world?.t.cleanup();
    world?.home.cleanup();
    expect(left).toBe("containers 0\ndecoys 0\nimages 0\nroot gone");
  }, 5 * MINUTE);

  const session = async (id: string) =>
    unwrap(await getSession(need().t.db, id));
  const spawn = (id: string, extra: Partial<SessionSpawnPayload> = {}) =>
    need().started.lifecycle.handlers.spawn.handle(
      spawnPayload(id, extra),
      CMD,
    );
  const stop = (id: string, mode: "graceful" | "kill") =>
    need().started.lifecycle.handlers.stop.handle(
      { session_id: id, mode },
      CMD,
    );

  test(
    "a fixture session runs end to end on the container: spawn, run, terminal, stop, container reaped",
    async () => {
      const began = Date.now();
      unwrap(
        await spawn("L1", {
          executor_id: ID,
          workspace_id: "ws",
          prompt: "go",
        }),
      );
      await vi.waitFor(async () => {
        const s = await session("L1");
        expect(s.state).toBe("idle");
        expect(s.executor_ref).toMatch(new RegExp(`^ctr:${ID}:[0-9a-f]{12}:`));
      }, WAIT);
      const s = await session("L1");
      note(
        `L1: idle after ${Date.now() - began} ms; ref ${s.executor_ref}; root ${s.session_root}`,
      );
      expect(s.session_root).toBe("/frm/s/L1");
      expect(sessionContainers("L1")).toHaveLength(1);
      const facts = remote(
        [
          `cat ${ROOT}/work/L1/repo/.git/objects/info/alternates`,
          `cat ${ROOT}/work/L1/.frm/home/.frm-home.lock; echo`,
          `git -C ${ROOT}/mirror/repo_1.git rev-parse refs/heads/main`,
        ].join("; "),
      );
      note(`L1 on the host: ${facts.replaceAll("\n", " | ")}`);
      expect(lines(facts)).toEqual([
        `${ROOT}/mirror/repo_1.git/objects`,
        "L1",
        expect.stringMatching(/^[0-9a-f]{40}$/),
      ]);
      unwrap(await stop("L1", "graceful"));
      await vi.waitFor(() => {
        expect(sessionContainers("L1")).toEqual([]);
      }, WAIT);
      note(`L1: ${(await session("L1")).state}; its container reaped by label`);
    },
    10 * MINUTE,
  );

  test(
    "a multi-repo session on the container: each repo pushed into its mirror and cloned --reference as a sibling under its root, run 1 ends, container reaped",
    async () => {
      const began = Date.now();
      unwrap(
        await spawn("L5", {
          executor_id: ID,
          workspace_id: "wm",
          prompt: "go",
        }),
      );
      await vi.waitFor(async () => {
        expect((await session("L5")).state).toBe("idle");
      }, WAIT);
      const facts = remote(
        [
          `git -C ${ROOT}/work/L5/repo rev-parse --abbrev-ref HEAD`,
          `git -C ${ROOT}/work/L5/lib rev-parse --abbrev-ref HEAD`,
          `cat ${ROOT}/work/L5/lib/.git/objects/info/alternates`,
          `git -C ${ROOT}/mirror/repo_2.git rev-parse refs/heads/main`,
          `git -C ${ROOT}/work/L5/lib rev-parse HEAD`,
        ].join("; "),
      );
      note(
        `L5: idle after ${Date.now() - began} ms; on the host: ${facts.replaceAll("\n", " | ")}`,
      );
      const [appBranch, libBranch, alternates, libMain, libHead] = lines(facts);
      expect([appBranch, libBranch]).toEqual(["frm/L5", "frm/L5"]);
      expect(alternates).toBe(`${ROOT}/mirror/repo_2.git/objects`);
      expect(libHead).toBe(libMain);
      unwrap(await stop("L5", "graceful"));
      await vi.waitFor(() => {
        expect(sessionContainers("L5")).toEqual([]);
      }, WAIT);
      note(`L5: ${(await session("L5")).state}; its container reaped by label`);
    },
    10 * MINUTE,
  );

  test(
    "killing the executor's ssh kills the remote program; the session is then resumed or exited(error)",
    async () => {
      const w = need();
      unwrap(await spawn("L2", { executor_id: ID }));
      await vi.waitFor(async () => {
        expect((await session("L2")).state).toBe("idle");
      }, WAIT);
      const before = (await session("L2")).executor_ref ?? "";
      const ssh = lines(
        execFileSync("pgrep", ["-f", `UserKnownHostsFile=${knownHosts}`], {
          encoding: "utf8",
        }),
      ).map(Number);
      for (const pid of ssh) process.kill(pid, "SIGKILL");
      note(`L2: killed ${ssh.length} ssh processes of ${ID} under ${before}`);
      await vi.waitFor(async () => {
        expect(await w.executor.probe(before)).toBe("dead");
      }, WAIT);
      await w.started.lifecycle.reconcile();
      await vi.waitFor(async () => {
        const s = await session("L2");
        const resumed = s.state === "idle" && s.executor_ref !== before;
        const failed = s.state === "exited" && s.exit_reason === "error";
        expect(resumed || failed).toBe(true);
      }, WAIT);
      const after = await session("L2");
      note(
        `L2: ${after.state}${after.state === "exited" ? ` (${after.error_class}: ${after.error_message})` : ` under ${after.executor_ref}`}`,
      );
    },
    10 * MINUTE,
  );

  test(
    "reaping is label-scoped: an ended session's container goes; a decoy without frm.managed=1 and every unlabelled container stay",
    async () => {
      const w = need();
      remote(
        `docker run -d --pull never --label frm.managed=1 --label frm.executor=${ID} --label frm.session=L1 ${w.image} sleep 300 >/dev/null`,
      );
      const decoy = lines(
        remote(
          `docker run -d --pull never --label frm.test=${RUN} --label frm.executor=${ID} --label frm.session=L1 ${BASE} sleep 300`,
        ),
      )[0];
      // The decoy runs the base image: ours would lend it our labels (a container inherits them).
      expect(
        remote(
          `docker inspect -f '{{index .Config.Labels "frm.managed"}}' ${decoy ?? "none"}`,
        ).trim(),
      ).toBe("");
      expect(sessionContainers("L1")).toHaveLength(1);
      await w.started.lifecycle.reconcile();
      expect(sessionContainers("L1")).toEqual([]);
      expect(
        lines(remote(`docker ps -q --filter label=frm.test=${RUN}`)),
      ).toHaveLength(1);
      const after = new Set(unlabelled());
      const gone = w.unlabelledBefore.filter((id) => !after.has(id));
      note(
        `reap: L1's orphan removed; decoy ${decoy?.slice(0, 12) ?? "?"} kept; ${w.unlabelledBefore.length} unlabelled containers before, ${gone.length} missing after`,
      );
      expect(gone).toEqual([]);
    },
    5 * MINUTE,
  );

  test("the opted-in trust rule: an investigator and a reviewer on local are refused", async () => {
    // trust is an early admission gate: refused before the session's row exists.
    for (const [id, role] of [
      ["L3", "investigator"],
      ["L4", "reviewer"],
    ] as const) {
      const refused = await spawn(id, { role });
      expect(refused).toMatchObject({
        ok: false,
        error: {
          class: "admission_refused",
          message: expect.stringContaining("refused (trust)"),
        },
      });
      expect(await getSession(need().t.db, id)).toMatchObject({
        ok: false,
        error: { class: "not_found" },
      });
      note(`${id}: ${refused.ok ? "" : refused.error.message}`);
    }
  });

  test(
    "finished pin refs leave the executor's mirror at the next pass; a running gate's and a stranger's stay",
    async () => {
      const w = need();
      const gate = (
        id: string,
        kind: GateRow["kind"],
        state: GateRow["state"],
      ) => ({
        id,
        ticket_id: "ticket-1",
        kind,
        state,
        attempt: 1,
        subject_kind: "diff",
        subject_ref: "x",
        started_at: Date.now(),
      });
      unwrap(
        await seedRows(w.t.db, {
          tickets: [ticketRow(1, { workspace_id: "ws" })],
          gates: [
            gate("g-done", "code_review", "passed"),
            gate("g-run", "plan_review", "running"),
          ],
        }),
      );
      // L3 was refused before its row and L9 never had one: strangers' pins, kept.
      const mirrors = w.executor.mirrors;
      if (mirrors === undefined) throw new Error(`${ID} keeps no mirrors`);
      const head = git(join(w.home.path, "mirror.git"), "rev-parse", "main");
      const pins = [
        "refs/frm/gate/g-done",
        "refs/frm/gate/g-run",
        "refs/frm/pin/L3",
        "refs/frm/pin/L9",
      ];
      await mirrors.push({
        localMirror: join(w.home.path, "mirror.git"),
        name: "repo_1",
        refspecs: pins.map((ref) => `+${head}:${ref}`),
        signal: AbortSignal.timeout(2 * MINUTE),
      });
      const onHost = () =>
        lines(
          remote(
            `git --git-dir=${ROOT}/mirror/repo_1.git for-each-ref --format='%(refname)' refs/frm/`,
          ),
        ).toSorted();
      expect(onHost()).toEqual(pins.toSorted());
      expect(
        (await mirrors.listPins()).map((p) => `${p.name} ${p.ref}`).toSorted(),
      ).toEqual(pins.map((ref) => `repo_1 ${ref}`).toSorted());
      await w.started.lifecycle.reconcile();
      const left = onHost();
      note(`pin refs on ${HOST} after one pass: ${left.join(", ")}`);
      expect(left).toEqual([
        "refs/frm/gate/g-run",
        "refs/frm/pin/L3",
        "refs/frm/pin/L9",
      ]);
      expect(
        remote(
          `git --git-dir=${ROOT}/mirror/repo_1.git rev-parse refs/heads/main`,
        ).trim(),
      ).toBe(head);
    },
    5 * MINUTE,
  );

  test("a symlink out of mirror is refused on the docker host, by real path", async () => {
    remote(`ln -sfn ${ROOT}/work ${ROOT}/mirror/esc`);
    await expect(
      need().executor.exec(["ls"], { cwd: `${ROOT}/mirror/esc`, env: {} }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("leads to"),
    });
    note("host route: a cwd through mirror/esc -> work refused (EACCES)");
  });
});
