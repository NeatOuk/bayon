// FaultExecutor.end: the run's end refuses every new process, waits for an exec still
// returning and kills its process as it returns, kills each group launched through it that is
// still alive (one whose leader already exited included), and waits for it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemClock } from "@bayon/core";
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type ExecOpts,
  type Proc,
} from "@bayon/executors";
import { afterAll, expect, test } from "vitest";
import { FaultExecutor } from "./fault-executor.js";

const dir = mkdtempSync(join(tmpdir(), "frm-fault-end-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const env = { PATH: process.env["PATH"] ?? "" };
const FOREVER: Argv = [
  process.execPath,
  "-e",
  "setInterval(() => {}, 1 << 30)",
];

/** A leader that leaves one member in its group and exits: the group outlives its leader. */
const ORPHANING = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" }).unref();
`;

test(
  "end kills every group still alive, a leaderless one included, then refuses new processes",
  { timeout: 30_000 },
  async () => {
    const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
    const ex = new FaultExecutor(local);
    const done = await ex.exec([process.execPath, "-e", ""], {
      cwd: dir,
      env,
      stdin: "ignore",
    });
    await done.exited;
    const orphaning = await ex.exec([process.execPath, "-e", ORPHANING], {
      cwd: dir,
      env,
      stdin: "ignore",
    });
    try {
      await orphaning.exited;
      // Its leader is gone; its group is not.
      expect(await local.probe(orphaning.ref)).toBe("alive");
      expect(ex.launched()).toEqual([done.ref, orphaning.ref]);
      expect(ex.refsOf(dir)).toEqual([done.ref, orphaning.ref]);
      expect(await ex.end(systemClock, 10_000)).toEqual({
        killed: [orphaning.ref],
        alive: [],
      });
      expect(await local.probe(orphaning.ref)).toBe("dead");
      await expect(
        ex.exec([process.execPath, "-e", ""], { cwd: dir, env }),
      ).rejects.toMatchObject({ class: "interrupted" });
      expect(ex.launched()).toHaveLength(2);
    } finally {
      await local.cleanup(orphaning.ref, "hard");
    }
  },
);

/** The local executor, but each exec first waits for `gate`: an exec the run's end catches mid-way. */
class Gated extends LocalExecutor {
  readonly gate = Promise.withResolvers<undefined>();
  readonly refs: string[] = [];

  override async exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    await this.gate.promise;
    const proc = await super.exec(argv, opts);
    this.refs.push(proc.ref);
    return proc;
  }
}

test(
  "end waits for an exec still returning, kills its process as it returns, and only then looks",
  { timeout: 30_000 },
  async () => {
    const inner = new Gated({ id: "local", slots: new SlotCounter(2) });
    const ex = new FaultExecutor(inner);
    const order: string[] = [];
    const starting = ex.exec(FOREVER, { cwd: dir, env, stdin: "ignore" }).then(
      () => order.push("started"),
      (e: unknown) => {
        order.push("refused");
        return e;
      },
    );
    const ending = ex.end(systemClock, 10_000).then((r) => {
      order.push("ended");
      return r;
    });
    // The end has begun, and the exec is still in its executor: now it returns.
    await new Promise<void>((resolve) => setImmediate(resolve));
    inner.gate.resolve(undefined);
    const [refused, end] = await Promise.all([starting, ending]);
    try {
      expect(order).toEqual(["refused", "ended"]);
      expect(refused).toMatchObject({ class: "interrupted" });
      expect(inner.refs).toHaveLength(1);
      expect(ex.launched()).toEqual(inner.refs);
      expect(end.alive).toEqual([]);
      for (const ref of inner.refs) {
        expect(await inner.probe(ref)).toBe("dead");
      }
    } finally {
      for (const ref of inner.refs) await inner.cleanup(ref, "hard");
    }
  },
);
