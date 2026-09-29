import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { releaseRetained, retain } from "./retained.js";

// Retained output: detached before it is released, so its
// reader gets what is left and then EOF, never a premature-close error; draining while the reader
// is behind, unless forced.

const readAll = async (s: AsyncIterable<unknown>): Promise<string> => {
  const parts: string[] = [];
  for await (const chunk of s) parts.push(String(chunk));
  return parts.join("");
};

describe("retain", () => {
  test("a released source still yields what was written, then ends normally", async () => {
    const source = new PassThrough();
    const r = retain(source);
    source.write("last bytes, maybe the terminal\n");
    const read = readAll(r.kept);
    r.release();
    await expect(read).resolves.toBe("last bytes, maybe the terminal\n");
    expect(source.destroyed).toBe(true);
    await r.closed;
  });

  test("a reader that stopped leaves it draining; force releases and reports the bytes", () => {
    const source = new PassThrough();
    const r = retain(source);
    source.write(Buffer.alloc(64 * 1024));
    expect(r.draining()).toBe(true);
    const behind = releaseRetained([r], true, false);
    expect(behind.state).toBe("draining");
    expect(behind.pendingBytes).toBeGreaterThan(0);
    expect(source.destroyed).toBe(false);
    const forced = releaseRetained([r], true, true);
    expect(forced.state).toBe("released");
    expect(forced.pendingBytes).toBe(behind.pendingBytes);
    expect(source.destroyed).toBe(true);
  });

  test("before the child's exit a release is unknown and touches nothing", () => {
    const source = new PassThrough();
    const r = retain(source);
    expect(releaseRetained([r], false, true).state).toBe("unknown");
    expect(source.destroyed).toBe(false);
  });

  test("a source error reaches the reader, and never crashes when nobody reads yet", async () => {
    const source = new PassThrough();
    const r = retain(source);
    source.destroy(new Error("boom"));
    await expect(readAll(r.kept)).rejects.toThrow("boom");
  });

  test("release is idempotent", async () => {
    const source = new PassThrough();
    const r = retain(source);
    r.release();
    r.release();
    await expect(readAll(r.kept)).resolves.toBe("");
  });
});
