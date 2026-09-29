// RemoteProc paths the contract does not reach, on the docker-host route
// of a loopback executor: a kill before the program started, a silent channel, stdin credit.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { within } from "../contract.js";
import { SlotCounter } from "../slots.js";
import type { Argv } from "../types.js";
import type { ContainerExecutorConfigInput } from "./config.js";
import { ContainerExecutor } from "./container.js";
import { LoopbackTransport } from "./loopback.js";
import type { ExecutorDiagnostic } from "./proc.js";
import { parseRef } from "./ref.js";

const ID = "ctr-proc";
const node = (source: string): Argv => [process.execPath, "-e", source];
const forever = node("setInterval(() => {}, 1 << 30)");
const root = join(realpathSync(mkdtempSync(join(tmpdir(), "frm-proc-"))), "r");
const run = join(root, "run");
mkdirSync(run, { recursive: true });
const stopped: number[] = [];
afterAll(() => {
  for (const pid of stopped) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  rmSync(dirname(root), { recursive: true, force: true });
});

function executor(
  config: Partial<ContainerExecutorConfigInput> = {},
  onDiagnostic?: (d: ExecutorDiagnostic) => void,
): ContainerExecutor {
  return new ContainerExecutor({
    id: ID,
    slots: new SlotCounter(2),
    frmHome: root,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: root,
      image: "frm/test",
      heartbeat_ms: 100,
      kill_grace_ms: 500,
      ...config,
    },
    transport: new LoopbackTransport({
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    }),
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
}

const recordOf = (ref: string) =>
  JSON.parse(
    readFileSync(join(run, `${parseRef(ref, ID).token}.json`), "utf8"),
  ) as { shimPid: number; pgid: number };

describe("RemoteProc", { timeout: 15_000 }, () => {
  test("an abort while exec is starting still kills the program, once it has started", async () => {
    const ex = executor();
    const abort = new AbortController();
    const starting = ex.exec(forever, {
      cwd: run,
      env: {},
      signal: abort.signal,
    });
    abort.abort();
    const proc = await starting;
    expect(await within(proc.exited, "abort")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
  });

  test("a silent channel is closed by the watchdog: exited SIGKILL, the group killed out of band", async () => {
    const seen: ExecutorDiagnostic[] = [];
    const ex = executor({ deadman_ms: 400 }, (d) => seen.push(d));
    const proc = await ex.exec(forever, { cwd: run, env: {} });
    const { shimPid, pgid } = recordOf(proc.ref);
    stopped.push(shimPid);
    process.kill(shimPid, "SIGSTOP");
    expect(await within(proc.exited, "watchdog")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(seen.map((d) => d.kind)).toContain("lost");
    await vi.waitFor(() => expect(() => process.kill(pgid, 0)).toThrow(), {
      timeout: 5_000,
      interval: 20,
    });
  });

  test("stdin waits for credit a program never gives back, and fails once it exits", async () => {
    const ex = executor({ window_bytes: 1024 });
    const proc = await ex.exec(forever, { cwd: run, env: {} });
    let settled = false;
    const write = proc.stdin?.write(Buffer.alloc(512 * 1024));
    void write?.then(
      () => (settled = true),
      () => (settled = true),
    );
    await expect(ex.probe(proc.ref)).resolves.toBe("alive");
    expect(settled).toBe(false);
    proc.kill("SIGKILL");
    expect(await within(proc.exited, "kill")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    await expect(write).rejects.toMatchObject({ class: "internal" });
  });
});
