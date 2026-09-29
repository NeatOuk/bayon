// runner.conformance against the real docker host over ssh. Skipped unless
// FRM_CONTAINER=1 (after `pnpm -w build`: `frm executor image` puts each runner into the image
// through its adapter's own install lines, and sessions run it there):
//   FRM_CONTAINER=1 pnpm exec vitest run apps/supervisor/src/conformance/container.live.test.ts
// FRM_CONTAINER_HOST (user@host, required), FRM_CONTAINER_KEY (a 0600 key,
// default ~/.ssh/id_ed25519); the host key comes from the operator's ~/.ssh/known_hosts. The
// executor is registered and imaged by the operator's CLI on a network of its own, so the suite's
// MCP probe (test 11) goes through the gateway's relay and the reverse tunnel to a real API child.
// The host is shared: every object this run makes is labelled and removed by label; unlabelled
// containers are listed, never touched.
// With FRM_REAL_RUNNER=1 too, every runner with a real CLI whose credential is in this process's
// secret store (FRM_SECRET_<CREDENTIAL>=…) is certified there for real, at real spend, while a watch
// counts its secret in every argv, label, image and file on the host. The report goes to
// $FRM_LIVE_REPORT_DIR when set. Every secret check is a count or a boolean: none can print one.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { containerReadiness, systemClock } from "@bayon/core";
import { listRunnerCertifications, openDb, type Db } from "@bayon/db";
import { migrateUp } from "@bayon/db/supervisor";
import { unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter, type Executor } from "@bayon/executors";
import { RunnerConformanceResult } from "@bayon/proto";
import { RUNNER_IDS, loadAdapter, registrations } from "@bayon/runners";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { STUB_RUNNER_IDS } from "@bayon/runners/testing";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { upsertBootRows } from "../boot.js";
import type { Log } from "../lifecycle/context.js";
import { readHealthLimits } from "../lifecycle/health.js";
import { envSecrets, resolveSecrets } from "../lifecycle/secrets.js";
import {
  buildApi,
  startApiChild,
  type ApiChild,
} from "../lifecycle/testing/api-child.js";
import { CMD, tempHome } from "../lifecycle/testing/fixtures.js";
import { dbPath } from "../paths.js";
import {
  createPlacement,
  egressHostsOf,
  type Placement,
} from "../placement.js";
import { conformanceCommand } from "./command.js";
import { CONFORMANCE_MIRROR } from "./remote-workspace-port.js";
import { seedUnreadyRunner } from "./testing.js";

const LIVE = process.env["FRM_CONTAINER"] === "1";
const REAL = process.env["FRM_REAL_RUNNER"] === "1";
const [USER = "", HOST = ""] = (process.env["FRM_CONTAINER_HOST"] ?? "").split(
  "@",
);
if (LIVE && (USER === "" || HOST === ""))
  throw new Error("FRM_CONTAINER=1 needs FRM_CONTAINER_HOST=user@host");
const KEY =
  process.env["FRM_CONTAINER_KEY"] ?? join(homedir(), ".ssh", "id_ed25519");
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RUN = [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join("");
const HEX = randomBytes(4).toString("hex");
const ID = `ctr-c${HEX}`;
const NETWORK = `frm-cf-${HEX}`;
const ROOT = `/home/${USER}/frm/test/${RUN}`;
const ROOT_GUARD = new RegExp(
  `^/home/${USER}/frm/test/[0-9A-HJKMNP-TV-Z]{26}$`,
);
const LABELS = `--filter label=frm.managed=1 --filter label=frm.executor=${ID}`;
/** This executor's image, as a word for the docker host's shell. */
const IMAGE = `$(docker image ls -q ${LABELS} | head -1)`;
const OPERATOR = "conformance-live-operator-0123456789";
const MINUTE = 60_000;
/** How often the secret watch looks while a real runner runs. */
const WATCH_MS = 20_000;
/** Evidence lines: printed, and appended to $FRM_LIVE_REPORT when set. */
const REPORT = process.env["FRM_LIVE_REPORT"];
/** Where a real runner's conformance report is written, e.g. docs/conformance. */
const REPORT_DIR = process.env["FRM_LIVE_REPORT_DIR"];
const note = (line: string): void => {
  console.log(line);
  if (REPORT !== undefined) appendFileSync(REPORT, `${line}\n`);
};
const placementLog: Log = {
  info: () => undefined,
  warn: (obj, msg) => note(`warn: ${msg} ${JSON.stringify(obj)}`),
  error: (obj, msg) => note(`error: ${msg} ${JSON.stringify(obj)}`),
};

interface World {
  readonly home: ReturnType<typeof tempHome>;
  readonly db: Db;
  readonly api: ApiChild;
  readonly placement: Placement;
  readonly executor: Executor;
  readonly unlabelledBefore: readonly string[];
}
let world: World | undefined;
let knownHosts = "";
const need = (): World => {
  if (world === undefined) throw new Error("the live setup did not finish");
  return world;
};

/** ssh to the docker host on this test's own connection, never the executor's. */
const sshArgs = (command: string): string[] => [
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
];
/** A command of this test's own on the docker host. */
const remote = (command: string, input?: Buffer): string =>
  execFileSync("ssh", sshArgs(command), {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
/** The same, without blocking the run it watches; `input` goes on stdin, never argv. */
const remoteAsync = (command: string, input: Buffer): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(command), {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`ssh exited ${code}`)),
    );
    child.stdin.end(input);
  });
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
  buildApi();
  const home = tempHome("frm-g79-");
  const path = dbPath(home.path);
  const db = unwrap(await openDb({ path, clock: systemClock }));
  unwrap(await migrateUp(db));
  unwrap(await upsertBootRows(db, { registrations: registrations() }));
  const api = await startApiChild({
    home: home.path,
    dbPath: path,
    token: OPERATOR,
  });
  const added = frm(home.path, path, [
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
    NETWORK,
    "--min-free-pct",
    "5",
    "--known-hosts",
    join(homedir(), ".ssh", "known_hosts"),
  ]);
  note(`frm executor add: ${lines(added).join(" | ")}`);
  knownHosts = join(home.path, "executors", ID, "known_hosts");
  const unlabelledBefore = unlabelled();
  const imaged = frm(home.path, path, ["executor", "image", ID]);
  note(`frm executor image: ${lines(imaged).join(" | ")}`);
  const localSlots = new SlotCounter(4);
  // Executors from their rows, as the daemon does; the container's /mcp goes through
  // its gateway and a reverse tunnel to the API child.
  const placement = createPlacement({
    frmHome: home.path,
    mcpUrl: api.mcpUrl,
    local: {
      executor: new LocalExecutor({ id: "local", slots: localSlots }),
      slots: localSlots,
    },
    // The runners' own hosts, as the daemon allows them (main.ts): with none, the gateway
    // refuses a real runner's API, as first live run found.
    egressHosts: egressHostsOf(
      new Map(RUNNER_IDS.map((id) => [id, unwrap(loadAdapter(id))])),
    ),
    log: placementLog,
  });
  await placement.load(db);
  const executor = placement.loaded().get(ID)?.executor;
  if (executor === undefined)
    throw new Error(`${ID} was not built from its row`);
  await untilHealthy(db, executor);
  noteImage();
  return { home, db, api, placement, executor, unlabelledBefore };
}

/** Health checks asked before the first suite gives up. */
const HEALTH_TRIES = 12;

/**
 * The m3 container smoke's C0: a health check every 10 s until the executor is healthy with its
 * /mcp tunnel up. Each suite's pre-flight asks once, and the first check (re)starts the tunnel: a
 * probe that races the tunnel's bind answers 502, and the suite is refused before it starts, as
 * second live run found once its gateway matched `frm executor image`'s and was kept.
 */
async function untilHealthy(db: Db, executor: Executor): Promise<void> {
  const limits = unwrap(await readHealthLimits(db));
  for (let i = 1; ; i += 1) {
    const report = await executor.health(limits);
    if (report.healthy) {
      note(`${executor.id} healthy after ${i} check(s)`);
      return;
    }
    note(`health check ${i}: ${JSON.stringify(report.detail["failures"])}`);
    if (i >= HEALTH_TRIES) {
      throw new Error(`${executor.id} is not healthy after ${i} checks`);
    }
    // Real time: a live host's tunnel.
    await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  }
}

/**
 * The image's size and layers, and what each runner put in it, run as a session runs it
 * (read-only, the host user, no network, a labelled throwaway container): node on PATH beside
 * each runner's files, and each executable one's `--version`.
 */
function noteImage(): void {
  note(
    `image: ${remote(`docker image ls ${LABELS} --format '{{.Repository}}:{{.Tag}} {{.Size}}'`).trim()}`,
  );
  note(
    `image layers: ${lines(
      remote(
        `docker history --no-trunc --format '{{.Size}} {{.CreatedBy}}' ${IMAGE} | cut -c1-160`,
      ),
    ).join(" | ")}`,
  );
  const probe = [
    "command -v node",
    'for f in /opt/frm/runners/*/*; do if [ -x "$f" ]; then echo "$f: $("$f" --version 2>&1 | head -n 1)"; else ls -l "$f"; fi; done',
  ].join("; ");
  note(
    `runners in the image: ${remote(
      `docker run --rm --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" -e HOME=/tmp --label frm.managed=1 --label frm.executor=${ID} --entrypoint sh ${IMAGE} -c '${probe}'`,
    )
      .trim()
      .replaceAll("\n", " | ")}`,
  );
}

const SecretNames = z.looseObject({
  secretEnvAnyOf: z.array(z.array(z.string())).default([]),
});

/**
 * The runners a real certification can run here: a real CLI stands behind each stand-in, it can
 * run in a container, and one of its credentials is in this process's secret store. With them,
 * the values, to watch for.
 */
async function withCredentials(): Promise<
  readonly { readonly id: string; readonly secrets: readonly string[] }[]
> {
  const store = envSecrets(process.env);
  const found: { id: string; secrets: string[] }[] = [];
  for (const reg of registrations()) {
    const names = SecretNames.parse(reg.runner.defaults).secretEnvAnyOf;
    if (
      !STUB_RUNNER_IDS.includes(reg.runner.id) ||
      !containerReadiness(reg.runner.defaults).ready ||
      names.length === 0
    ) {
      continue;
    }
    const resolved = await resolveSecrets(store, [], names);
    if (resolved.ok) {
      found.push({
        id: reg.runner.id,
        secrets: resolved.value.map(([, value]) => value),
      });
    }
  }
  return found;
}

/**
 * Where a secret must never be on the docker host (Invariant 11): each of this executor's labelled
 * containers as docker keeps it (labels, env, args), its image and that image's history (build
 * args, RUN lines), every file under the executor's root, and the host's process table. The
 * secrets arrive on stdin; the script prints counts only.
 */
const WATCH_SCRIPT = [
  "pats=$(cat)",
  'c() { grep -cF -f <(printf "%s\\n" "$pats") || true; }',
  `echo sessions $(docker ps -q ${LABELS} --filter label=frm.session | wc -l)`,
  `echo containers $(docker ps -aq ${LABELS} | xargs -r docker inspect | c)`,
  `echo image $( { docker image inspect ${IMAGE}; docker history --no-trunc ${IMAGE}; } | c)`,
  `echo files $(grep -rlF -f <(printf "%s\\n" "$pats") ${ROOT} 2>/dev/null | wc -l)`,
  "echo processes $(ps -eww -o args= | c)",
].join("\n");

const execFileAsync = promisify(execFile);

/** Counts `secrets` there, and in this host's process table, every WATCH_MS until stopped. */
function watchSecrets(secrets: readonly string[]): {
  readonly stop: () => Promise<Readonly<Record<string, number>>>;
} {
  const max: Record<string, number> = { ticks: 0, failed: 0 };
  const input = Buffer.from(`${secrets.join("\n")}\n`);
  const record = (key: string, value: number): void => {
    max[key] = Math.max(max[key] ?? 0, value);
  };
  async function tick(): Promise<void> {
    for (const line of lines(await remoteAsync(WATCH_SCRIPT, input))) {
      const [key = "", value = ""] = line.split(" ");
      record(key, Number(value));
    }
    const { stdout } = await execFileAsync("ps", ["-axww", "-o", "args="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    record(
      "local_processes",
      lines(stdout).filter((l) => secrets.some((s) => l.includes(s))).length,
    );
    max["ticks"] = (max["ticks"] ?? 0) + 1;
  }
  let stopping = false;
  let wake = (): void => undefined;
  const loop = (async () => {
    while (!stopping) {
      await tick().catch((e: unknown) => {
        max["failed"] = (max["failed"] ?? 0) + 1;
        note(`secret watch: a look failed: ${String(e).split("\n")[0]}`);
      });
      if (stopping) break; // stop() came during the look: no further wait
      // Real time: this watches a live run.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WATCH_MS);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    async stop() {
      stopping = true;
      wake();
      await loop;
      await tick(); // once more, after the run
      return max;
    },
  };
}

/** Files under `dir` that hold any of `secrets`: a count, never the value. */
function filesHolding(dir: string, secrets: readonly string[]): number {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "latin1"))
    .filter((text) => secrets.some((s) => text.includes(s))).length;
}

const CostUsd = z.looseObject({
  spend: z.looseObject({ cost_usd: z.number() }),
});

describe.skipIf(!LIVE)(`conformance on a container executor on ${HOST}`, () => {
  beforeAll(async () => {
    world = await setup();
  }, 20 * MINUTE);

  afterAll(async () => {
    const w = world;
    if (w !== undefined) {
      await w.placement.close();
      w.api.stop();
    }
    remote(
      [
        `docker ps -aq ${LABELS} | xargs -r docker rm -f >/dev/null`,
        `docker network ls -q ${LABELS} | xargs -r docker network rm >/dev/null`,
        `docker image ls -q ${LABELS} | sort -u | xargs -r docker image rm -f >/dev/null`,
        `docker volume ls -q ${LABELS} | xargs -r docker volume rm >/dev/null`,
      ].join("\n"),
    );
    if (ROOT_GUARD.test(ROOT)) remote(`rm -rf ${ROOT}`);
    const left = remote(
      [
        `echo containers $(docker ps -aq ${LABELS} | wc -l)`,
        `echo networks $(docker network ls -q ${LABELS} | wc -l)`,
        `echo images $(docker image ls -q ${LABELS} | sort -u | wc -l)`,
        `echo root $(test -e ${ROOT} && echo left || echo gone)`,
      ].join("\n"),
    ).trim();
    note(`teardown: ${ID}: ${left.replaceAll("\n", ", ")}`);
    const after = new Set(unlabelled());
    const gone = (w?.unlabelledBefore ?? []).filter((id) => !after.has(id));
    note(
      `unlabelled containers: ${w?.unlabelledBefore.length ?? "?"} before, ${gone.length} of them missing after`,
    );
    if (w !== undefined) {
      await w.db.close();
      w.home.cleanup();
    }
    expect(left).toBe("containers 0\nnetworks 0\nimages 0\nroot gone");
    expect(gone).toEqual([]);
  }, 5 * MINUTE);

  test(
    "the fixture is certified on the container, test 11 through the relay and the tunnel, and nothing of the run is left",
    async () => {
      const w = need();
      const conformance = conformanceCommand({
        db: w.db,
        clock: systemClock,
        log: pino({ level: "warn" }),
        frmHome: w.home.path,
        executors: w.placement.loaded(),
        adapters: new Map([
          [
            "fixture",
            // No command: a placed session runs the image's node on the image's program.
            createFixtureAdapter({ clock: systemClock }),
          ],
        ]),
        secrets: envSecrets({}),
        path: process.env["PATH"] ?? "",
        mcpUrl: w.api.mcpUrl,
      });
      const began = Date.now();
      const done = await conformance.handler.handle(
        {
          runner_id: "fixture",
          executor_id: ID,
          model_id: "fixture.cheap",
          report_dir: join(w.home.path, "reports"),
        },
        CMD,
      );
      await conformance.stop();
      const seconds = Math.round((Date.now() - began) / 1000);
      const result = RunnerConformanceResult.parse(unwrap(done));
      const s = result.summary;
      note(
        `conformance fixture@${ID}: ${seconds} s; pass ${s.passed.join(",")}; N/A ${s.na.join(",")}; fail ${s.failed.join(",") || "-"}; incomplete ${s.incomplete.join(",") || "-"}`,
      );
      const report = readFileSync(result.report_path, "utf8");
      note(
        report.split("\n").find((l) => l.startsWith("executor ")) ??
          "no executor line in the report",
      );
      expect(s).toMatchObject({
        failed: [],
        incomplete: [],
        certifiable: true,
        gate_eligible: true,
      });
      expect(s.passed).toContain(11);
      expect(result.stored).toBe(true);
      const onHost = lines(
        remote(
          [
            `docker ps -aq ${LABELS} --filter label=frm.session | wc -l`,
            `ls -A ${ROOT}/work | wc -l`,
            `git --git-dir=${ROOT}/mirror/${CONFORMANCE_MIRROR}.git for-each-ref --format='%(refname)'`,
          ].join("; "),
        ),
      );
      note(`on the host after the run: ${onHost.join(" | ")}`);
      expect(onHost).toEqual([
        "0",
        "0",
        expect.stringMatching(/^refs\/heads\/fixture-[0-9a-f]{12}$/),
      ]);
    },
    30 * MINUTE,
  );

  test.skipIf(!REAL)(
    "each real runner with a credential here is certified on the container over it, at recorded spend; its secret is in no argv, label, image or file",
    async () => {
      const w = need();
      const runners = await withCredentials();
      note(
        `real runners with a credential here: ${runners.map((r) => r.id).join(", ") || "none"}`,
      );
      expect(runners.length).toBeGreaterThan(0);
      for (const r of runners) {
        const conformance = conformanceCommand({
          db: w.db,
          clock: systemClock,
          log: pino({ level: "warn" }),
          frmHome: w.home.path,
          executors: w.placement.loaded(),
          // The daemon's own adapter: a placed session runs the image's CLI.
          adapters: new Map([[r.id, unwrap(loadAdapter(r.id))]]),
          secrets: envSecrets(process.env),
          path: process.env["PATH"] ?? "",
          mcpUrl: w.api.mcpUrl,
        });
        const watch = watchSecrets(r.secrets);
        const began = Date.now();
        let done;
        try {
          done = await conformance.handler.handle(
            {
              runner_id: r.id,
              executor_id: ID,
              model_id: `${r.id}.cheap`,
              report_dir: REPORT_DIR ?? join(w.home.path, "reports"),
            },
            CMD,
          );
        } finally {
          await conformance.stop();
        }
        const seen = await watch.stop();
        const seconds = Math.round((Date.now() - began) / 1000);
        const result = RunnerConformanceResult.parse(unwrap(done));
        const s = result.summary;
        note(
          `conformance ${r.id}@${ID}: ${seconds} s; pass ${s.passed.join(",")}; N/A ${s.na.join(",")}; fail ${s.failed.join(",") || "-"}; incomplete ${s.incomplete.join(",") || "-"}; stored ${result.stored}, passed_at ${result.passed_at ?? "null"}`,
        );
        note(`report ${result.report_path}`);
        note(
          readFileSync(result.report_path, "utf8")
            .split("\n")
            .slice(0, 7)
            .filter((l) => l !== "")
            .join(" | "),
        );
        const row = unwrap(await listRunnerCertifications(w.db)).find(
          (c) => c.runner_id === r.id && c.executor_id === ID,
        );
        const spend =
          row === undefined
            ? null
            : CostUsd.parse(JSON.parse(row.result_json)).spend.cost_usd;
        note(`spend recorded: $${spend ?? "none"}`);
        const local = filesHolding(w.home.path, r.secrets);
        note(
          `secret watch: ${JSON.stringify(seen)}; files under FRM_HOME holding it: ${local}`,
        );
        expect(s).toMatchObject({
          failed: [],
          incomplete: [],
          certifiable: true,
          gate_eligible: true,
          unattended_allowed: true,
        });
        expect(s.passed).toContain(11);
        expect(result.stored).toBe(true);
        expect(result.passed_at).not.toBeNull();
        expect(spend).toBeGreaterThan(0);
        expect(seen).toMatchObject({
          failed: 0,
          containers: 0,
          image: 0,
          files: 0,
          processes: 0,
          local_processes: 0,
        });
        expect(seen["ticks"]).toBeGreaterThan(1);
        expect(seen["sessions"]).toBeGreaterThan(0); // it looked while sessions ran
        expect(local).toBe(0);
        expect(
          lines(
            remote(
              `docker ps -aq ${LABELS} --filter label=frm.session | wc -l; ls -A ${ROOT}/work | wc -l`,
            ),
          ),
        ).toEqual(["0", "0"]);
      }
    },
    45 * MINUTE,
  );

  test("a runner that cannot run in a container is refused on it in under a second, and nothing is placed", async () => {
    const w = need();
    const unready = "ctr-unready";
    await seedUnreadyRunner(w.db, unready, "no image holds it (live test)");
    const conformance = conformanceCommand({
      db: w.db,
      clock: systemClock,
      log: pino({ level: "warn" }),
      frmHome: w.home.path,
      executors: w.placement.loaded(),
      adapters: new Map(),
      secrets: envSecrets({}),
      path: process.env["PATH"] ?? "",
      mcpUrl: w.api.mcpUrl,
    });
    try {
      const began = performance.now();
      const done = await conformance.handler.handle(
        {
          runner_id: unready,
          executor_id: ID,
          model_id: `${unready}.cheap`,
          report_dir: join(w.home.path, "refused"),
        },
        CMD,
      );
      const ms = Math.round(performance.now() - began);
      note(
        `refused ${unready}@${ID} in ${ms} ms: ${done.ok ? "NOT refused" : `${done.error.class}: ${done.error.message}`}`,
      );
      expect(ms).toBeLessThan(1_000);
      expect(done).toMatchObject({
        ok: false,
        error: { class: "validation", retryable: false },
      });
    } finally {
      await conformance.stop();
    }
    expect(
      lines(
        remote(`docker ps -aq ${LABELS} --filter label=frm.session | wc -l`),
      ),
    ).toEqual(["0"]);
  });
});
