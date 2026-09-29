// A container executor on the loopback for the conformance tests:
// the real ContainerExecutor and its scripts with a stand-in docker, every exec's cwd recorded,
// its health answered here (needs a real docker), the most sessions it held at once,
// and a switch that makes release fail. Test-only.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { judgeExecutorHealth, type HealthLimits } from "@bayon/core";
import {
  ContainerExecutor,
  SlotCounter,
  type Argv,
  type ExecOpts,
  type ExecutorHealthReport,
  type Prepared,
  type PrepareSpec,
  type Proc,
  type ReleaseOptions,
} from "@bayon/executors";
import { LoopbackTransport, installFakeDocker } from "@bayon/executors/testing";
import type { Db } from "@bayon/db";
import { upsertRegistration } from "@bayon/db/supervisor";
import { createFixtureAdapter } from "@bayon/runners/fixture";
import { registrationRows } from "../boot.js";

export const LOOPBACK_IMAGE = "frm/test";
export const LOOPBACK_RTT_MS = 3;
/** The "image's" PATH: node for the shim, git, and /sbin for this host's sha256sum. */
export const LOOPBACK_ENV_PATH = `${dirname(process.execPath)}:/usr/bin:/bin:/sbin`;

/**
 * A runner row `id` whose defaults say it cannot run in a container, for the refusal
 * tests: every registered runner is ready since an earlier change. Refused before any adapter is looked up,
 * so it needs none. A failure throws with the result's own message (this module is not a test
 * file, so @bayon/db/testing's unwrap is not for it).
 */
export async function seedUnreadyRunner(
  db: Db,
  id: string,
  reason: string,
): Promise<void> {
  const base = createFixtureAdapter().registration().runner;
  const rows = registrationRows({
    models: [],
    runner: {
      ...base,
      id,
      adapter: id,
      defaults: { containerUnready: reason },
    },
  });
  if (!rows.ok) {
    throw new Error(`cannot build runner ${id}: ${rows.error.message}`);
  }
  const upserted = await upsertRegistration(db, rows.value);
  if (!upserted.ok) {
    throw new Error(`cannot seed runner ${id}: ${upserted.error.message}`);
  }
}

export class LoopbackContainer extends ContainerExecutor {
  readonly cwds: string[] = [];
  held = 0;
  peak = 0;
  healthy = true;
  failRelease = false;

  override health(limits: HealthLimits): Promise<ExecutorHealthReport> {
    const { healthy, detail } = judgeExecutorHealth({
      checkedAt: Date.now(),
      disk: [],
      clockSkewMs: 0,
      limits,
      failures: this.healthy ? [] : ["loopback: switched unhealthy (test)"],
    });
    return Promise.resolve({
      healthy,
      detail: { ...detail, rtt_ms: LOOPBACK_RTT_MS, image: LOOPBACK_IMAGE },
    });
  }

  override async prepare(spec: PrepareSpec): Promise<Prepared> {
    const prepared = await super.prepare(spec);
    this.held += 1;
    this.peak = Math.max(this.peak, this.held);
    return prepared;
  }

  override exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    this.cwds.push(opts.cwd);
    return super.exec(argv, opts);
  }

  override async release(sessionId: string, o: ReleaseOptions): Promise<void> {
    if (this.failRelease) throw new Error("release failed (test switch)");
    await super.release(sessionId, o);
    this.held -= 1;
  }
}

export interface Loopback {
  readonly executor: LoopbackContainer;
  readonly slots: SlotCounter;
  /** remote_root: work/<sid> are the session roots, mirror/ the executor's mirrors. */
  readonly remoteRoot: string;
}

/** A loopback container executor `id` under `home`, with its own remote root and stand-in docker. */
export function loopbackContainer(home: string, id: string): Loopback {
  const remoteRoot = join(home, `remote-${id}`);
  mkdirSync(remoteRoot, { recursive: true });
  const docker = installFakeDocker(join(home, `docker-${id}`), id);
  const slots = new SlotCounter(2);
  const executor = new LoopbackContainer({
    id,
    slots,
    frmHome: home,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: remoteRoot,
      image: LOOPBACK_IMAGE,
      min_free_pct: 0,
      heartbeat_ms: 200,
      kill_grace_ms: 1_000,
      env_path: LOOPBACK_ENV_PATH,
    },
    transport: new LoopbackTransport({ ...docker.env, HOME: home }),
    paths: {
      sessions: join(remoteRoot, "work"),
      run: join(remoteRoot, "run"),
      shim: "/opt/frm/exec-shim.mjs",
    },
  });
  return { executor, slots, remoteRoot };
}
