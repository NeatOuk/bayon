// Executor.exitedAt and releasePipes on the container executor, over the
// loopback transport: the program's own exit is its exit frame; a release before that is unknown,
// and a reader that stopped keeps it draining until the release is forced, which reports the bytes
// it cut and closes the channel so the handle settles.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { within } from "../contract.js";
import { SlotCounter } from "../slots.js";
import type { Argv } from "../types.js";
import { ContainerExecutor } from "./container.js";
import { LoopbackTransport } from "./loopback.js";

const ID = "ctr-pipes";
const node = (source: string): Argv => [process.execPath, "-e", source];
const root = join(realpathSync(mkdtempSync(join(tmpdir(), "frm-pipes-"))), "r");
const run = join(root, "run");
mkdirSync(run, { recursive: true });
afterAll(() => rmSync(dirname(root), { recursive: true, force: true }));

const ex = new ContainerExecutor({
  id: ID,
  slots: new SlotCounter(2),
  frmHome: root,
  config: {
    ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
    remote_root: root,
    image: "frm/test",
    heartbeat_ms: 100,
    kill_grace_ms: 500,
  },
  transport: new LoopbackTransport({
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  }),
});

const readAll = async (s: AsyncIterable<Uint8Array>): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of s) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString("utf8");
};

describe("container releasePipes", { timeout: 15_000 }, () => {
  test("an unknown ref is unknown, and has no exit", () => {
    expect(ex.releasePipes("nothing")).toEqual({
      state: "unknown",
      pendingBytes: 0,
    });
    expect(ex.exitedAt("nothing")).toBeNull();
  });

  test("a program read to its end leaves nothing to release", async () => {
    const proc = await ex.exec(node("process.stdout.write('hello\\n')"), {
      cwd: run,
      env: {},
      stdin: "ignore",
    });
    await expect(readAll(proc.stdout)).resolves.toBe("hello\n");
    await within(proc.exited, "exit");
    // Its entry goes once nothing more can come: a release then touches nothing.
    await vi.waitFor(() => {
      expect(ex.releasePipes(proc.ref).state).toBe("unknown");
    });
  });

  test("a reader that stopped keeps it draining; forced, the bytes are reported and the handle settles", async () => {
    const proc = await ex.exec(
      node("process.stdout.write('x'.repeat(40 * 1024))"),
      { cwd: run, env: {}, stdin: "ignore" },
    );
    await vi.waitFor(() => {
      expect(ex.exitedAt(proc.ref)).not.toBeNull();
    });
    const behind = ex.releasePipes(proc.ref);
    expect(behind.state).toBe("draining");
    expect(behind.pendingBytes).toBeGreaterThan(0);
    const forced = ex.releasePipes(proc.ref, { force: true });
    expect(forced.state).toBe("released");
    expect(await within(proc.exited, "exit after release")).toEqual({
      code: 0,
      signal: null,
    });
  });
});
