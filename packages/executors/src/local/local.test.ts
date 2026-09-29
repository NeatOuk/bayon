import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { describeExecutorContract, readAll, within } from "../contract.js";
import { SlotCounter } from "../slots.js";
import type { Argv, ExecOpts, Proc } from "../types.js";
import { LocalExecutor } from "./local.js";
import { readProc } from "./proc-info.js";

const node = (source: string): Argv => [process.execPath, "-e", source];
const SH_ENV = { PATH: "/bin:/usr/bin" };

describeExecutorContract("local", () => {
  const slots = new SlotCounter(2);
  return {
    slots,
    // A real disk for the contract's health test.
    executor: new LocalExecutor({
      id: "local",
      slots,
      diskPaths: () => [tmpdir()],
    }),
    programs: {
      cat: node("process.stdin.pipe(process.stdout)"),
      interleave: node(`
        const rl = require("node:readline").createInterface({ input: process.stdin });
        const acks = rl[Symbol.asyncIterator]();
        (async () => {
          for (const [line, out] of [[1, process.stdout], [2, process.stderr], [3, process.stdout], [4, process.stderr]]) {
            out.write(line + "\\n");
            await acks.next();
          }
          rl.close();
          process.stdin.destroy();
        })();`),
      whereami: node(
        'process.stdout.write([process.cwd(), process.env.FOO, process.env.HOME ?? "-", ""].join("\\n"))',
      ),
      exit3: node("process.exit(3)"),
      forever: node("setInterval(() => {}, 1 << 30)"),
      missing: ["/nonexistent/frm-no-such-program"],
      ptyEcho: node(`
        const size = () => process.stdout.write("size " + process.stdout.columns + "x" + process.stdout.rows + "\\n");
        process.stdout.on("resize", size);
        size();
        process.stdin.resume();`),
    },
  };
});

describe("LocalExecutor", { timeout: 15_000 }, () => {
  const executor = new LocalExecutor({
    id: "local",
    slots: new SlotCounter(1),
  });
  let dir = "";
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "frm-local-")));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  // Every process a test starts, killed with its group after the test: one that fails before its
  // own kill leaves nothing running.
  let started: Proc[] = [];
  const exec = async (argv: Argv, opts: ExecOpts): Promise<Proc> => {
    const proc = await executor.exec(argv, opts);
    started = [...started, proc];
    return proc;
  };
  afterEach(async () => {
    const ending = started;
    started = [];
    for (const proc of ending) await executor.cleanup(proc.ref, "hard");
    await within(Promise.all(ending.map((p) => p.exited)), "reaping");
  });

  const firstLine = async (proc: Proc): Promise<string> => {
    const next = await within(
      proc.stdout[Symbol.asyncIterator]().next(),
      "first line",
    );
    if (next.done === true) throw new Error("stdout closed early");
    return new TextDecoder().decode(next.value).split("\n")[0] ?? "";
  };
  const parseRef = (ref: string): { pid: number; start: number } => {
    const [, pid, start] = ref.split(":");
    return { pid: Number(pid), start: Number(start) };
  };

  test("prepare creates the session root, private to the operator", async () => {
    const root = join(dir, "sessions", "ses-1");
    expect(await executor.prepare({ sessionId: "ses-1", root })).toEqual({
      root,
    });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  test("kill reaches every process in the group", async () => {
    // The grandchild holds stdout open, so stdout ends only once it is dead too.
    const proc = await exec(["/bin/sh", "-c", "sleep 1000 & echo $!; wait"], {
      cwd: dir,
      env: SH_ENV,
    });
    const grandchild = Number(await firstLine(proc));
    expect(await readProc(grandchild)).toMatchObject({ zombie: false });
    proc.kill();
    await within(readAll(proc.stdout), "grandchild closing stdout");
    expect(await within(proc.exited, "exit")).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  });

  test("detached: false still signals the process itself", async () => {
    const proc = await exec(node("setInterval(() => {}, 1 << 30)"), {
      cwd: dir,
      env: {},
      detached: false,
    });
    proc.kill();
    expect(await within(proc.exited, "exit")).toEqual({
      code: null,
      signal: "SIGTERM",
    });
  });

  test("kill after exit signals nothing: the pid may belong to someone else by then", async () => {
    // sh exits at once, leaving its background sleep in the group. The post-exit kill must not
    // reach it.
    const proc = await exec(["/bin/sh", "-c", "sleep 1000 & echo $!"], {
      cwd: dir,
      env: SH_ENV,
    });
    const orphan = Number(await firstLine(proc));
    expect(await within(proc.exited, "exit")).toEqual({
      code: 0,
      signal: null,
    });
    proc.kill("SIGKILL");
    const info = await readProc(orphan);
    if (info !== null)
      await executor.cleanup(`local:${orphan}:${info.start}`, "hard");
    expect(info).toMatchObject({ zombie: false });
  });

  test("probe: a reused pid (same pid, other start time) reads as dead", async () => {
    const proc = await exec(node("setInterval(() => {}, 1 << 30)"), {
      cwd: dir,
      env: {},
    });
    const { pid, start } = parseRef(proc.ref);
    expect(proc.ref).toMatch(/^local:\d+:\d+$/);
    expect(await executor.probe(proc.ref)).toBe("alive");
    expect(await executor.probe(`local:${pid}:${start - 1}`)).toBe("dead");
    proc.kill("SIGKILL");
    await within(proc.exited, "exit");
  });

  test("probe: a zombie (exited, not reaped) reads as dead", async () => {
    // `sleep 0` exits at once; its parent then execs a `sleep` that never reaps it.
    const proc = await exec(
      ["/bin/sh", "-c", "sleep 0 & echo $!; exec sleep 1000"],
      { cwd: dir, env: SH_ENV },
    );
    const zombie = Number(await firstLine(proc));
    const deadline = Date.now() + 5_000;
    let info = await readProc(zombie);
    while (info?.zombie !== true && Date.now() < deadline)
      info = await readProc(zombie);
    if (info?.zombie !== true)
      throw new Error(`pid ${zombie} never became a zombie`);
    expect(await executor.probe(`local:${zombie}:${info.start}`)).toBe("dead");
    proc.kill("SIGKILL");
    await within(proc.exited, "exit");
  });

  test("probe: SIGKILL of the leader alone leaves its group alive until cleanup reaches the child", async () => {
    // A turn host killed alone must not read as dead while the runner it started still works:
    // the reconciler would adopt a second one next to it (Invariant 12).
    const proc = await exec(
      ["/bin/sh", "-c", "sleep 1000 & echo $!; exec sleep 1000"],
      { cwd: dir, env: SH_ENV },
    );
    const child = Number(await firstLine(proc));
    const { pid } = parseRef(proc.ref);
    process.kill(pid, "SIGKILL"); // the leader only, not its group
    expect(await within(proc.exited, "exit")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(await readProc(pid)).toBeNull();
    expect(await readProc(child)).toMatchObject({ zombie: false });
    expect(await executor.probe(proc.ref)).toBe("alive");
    await executor.cleanup(proc.ref, "hard");
    const deadline = Date.now() + 5_000;
    let state = await executor.probe(proc.ref);
    while (state === "alive" && Date.now() < deadline)
      state = await executor.probe(proc.ref);
    expect(state).toBe("dead");
    expect(await readProc(child)).toBeNull();
  });

  test.each(["fake:1", "local:abc:1", "local:12", "local:0:5", "local:1:5"])(
    "probe and cleanup refuse %s",
    async (ref) => {
      await expect(executor.probe(ref)).rejects.toMatchObject({
        class: "validation",
      });
      await expect(executor.cleanup(ref, "hard")).rejects.toMatchObject({
        class: "validation",
      });
    },
  );
});
