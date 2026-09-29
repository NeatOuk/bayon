import { describe, expect, test } from "vitest";
import { LoopbackTransport } from "./loopback.js";
import { beforeDeadline, runRemote, startChild } from "./transport.js";

const loop = new LoopbackTransport({ PATH: "/usr/bin:/bin" });

describe("transport helpers", { timeout: 10_000 }, () => {
  test("runRemote: stdin in, stdout, stderr and the exit code out, one round trip observed", async () => {
    const ran = await runRemote(loop, "cat; echo err >&2; exit 4", {
      what: "echo",
      signal: AbortSignal.timeout(5_000),
      input: "hi",
    });
    expect(ran).toEqual({ code: 4, stdout: "hi", stderr: "err\n" });
    expect(loop.rttMs()).toEqual(expect.any(Number));
  });

  test("runRemote: the deadline kills the command and rejects `timeout`", async () => {
    const began = Date.now();
    await expect(
      runRemote(loop, "sleep 5", {
        what: "sleepy",
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toMatchObject({ class: "timeout", retryable: true });
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  test("a passed deadline refuses to start anything", async () => {
    await expect(loop.start("true", AbortSignal.abort())).rejects.toMatchObject(
      { class: "timeout" },
    );
    await expect(
      beforeDeadline(new Promise(() => undefined), AbortSignal.abort(), "w"),
    ).rejects.toMatchObject({ class: "timeout" });
  });

  test("a local program that cannot start is spawn_failed", async () => {
    await expect(
      startChild("/nonexistent/frm-ssh", [], {}),
    ).rejects.toMatchObject({ class: "spawn_failed" });
    expect(loop.transportError()).toBeNull();
    await loop.close();
  });
});
