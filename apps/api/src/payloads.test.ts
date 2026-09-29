import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { locatePayload, payloadTarget } from "./payloads.js";

const runtime = mkdtempSync(join(tmpdir(), "bayon-runtime-"));
afterAll(() => rmSync(runtime, { recursive: true, force: true }));

const SESSION = "01JSESSION";
const sessionDir = join(runtime, "sessions", SESSION);
const tool = join(sessionDir, "logs", "tool");
const sibling = join(runtime, "sessions", `${SESSION}-evil`);
mkdirSync(tool, { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(join(tool, "c1.txt"), "full output");
writeFileSync(join(runtime, "secret.txt"), "not this session's");
writeFileSync(join(sibling, "x.txt"), "another session's");
symlinkSync(join(runtime, "secret.txt"), join(tool, "out.txt"));
symlinkSync(join(tool, "c1.txt"), join(sessionDir, "logs", "in.txt"));

const refused = { ok: false, error: { class: "validation" } };
const missing = { ok: false, error: { class: "not_found" } };

describe("payloadTarget", () => {
  test.each([
    ["a parent escape", "../../secret.txt"],
    ["a deep escape", "../../../../../../../../etc/passwd"],
    ["an escape after a real prefix", "logs/../../other/x.txt"],
    ["an absolute path elsewhere", "/etc/passwd"],
    ["a sibling session whose id starts the same", `../${SESSION}-evil/x.txt`],
    ["the session directory itself", "."],
  ])("refuses %s", (_name, path) => {
    expect(payloadTarget(runtime, SESSION, path)).toMatchObject(refused);
  });

  test.each(["..", ".", "a/b", "", "x\u0000", "../sessions"])(
    "refuses the session id %j",
    (id) => {
      expect(payloadTarget(runtime, id, "logs/x.txt")).toMatchObject(refused);
    },
  );

  test("a relative path is inside the session directory; an absolute one must be", () => {
    const file = join(tool, "c1.txt");
    expect(payloadTarget(runtime, SESSION, "logs/tool/c1.txt")).toEqual({
      ok: true,
      value: { dir: sessionDir, file },
    });
    expect(payloadTarget(runtime, SESSION, file)).toMatchObject({ ok: true });
  });
});

/** Closes the handle of an ok result, if any — keeps tests from leaking fds. */
async function closeIfOpen(
  result: Awaited<ReturnType<typeof locatePayload>>,
): Promise<void> {
  if (result.ok) await result.value.handle.close();
}

describe("locatePayload", () => {
  test("finds a file and its size", async () => {
    const found = await locatePayload(runtime, SESSION, "logs/tool/c1.txt");
    expect(found).toMatchObject({ ok: true, value: { size: 11 } });
    await closeIfOpen(found);
  });

  test("follows a symlink that stays inside the session directory", async () => {
    const found = await locatePayload(runtime, SESSION, "logs/in.txt");
    expect(found).toMatchObject({ ok: true, value: { size: 11 } });
    await closeIfOpen(found);
  });

  test("refuses a symlink that leads out of it", async () => {
    expect(
      await locatePayload(runtime, SESSION, "logs/tool/out.txt"),
    ).toMatchObject(refused);
  });

  test("refuses an escape before touching the disk", async () => {
    expect(
      await locatePayload(runtime, SESSION, "../../secret.txt"),
    ).toMatchObject(refused);
  });

  test.each([
    ["a missing file", SESSION, "logs/tool/gone.txt"],
    ["a directory", SESSION, "logs"],
    ["a session with no directory", "01JNOSESSION", "logs/x.txt"],
  ])("%s is not_found", async (_name, id, path) => {
    expect(await locatePayload(runtime, id, path)).toMatchObject(missing);
  });

  test("stays pinned to its fd if the path is swapped for an escaping symlink after the check", async () => {
    const swapDir = join(sessionDir, "logs", "swap");
    mkdirSync(swapDir, { recursive: true });
    const swapFile = join(swapDir, "s.txt");
    const original = "original session-owned content";
    writeFileSync(swapFile, original);

    const found = await locatePayload(runtime, SESSION, "logs/swap/s.txt");
    expect(found).toMatchObject({ ok: true, value: { size: original.length } });
    if (!found.ok) throw new Error("expected locatePayload to succeed");

    // The race: after the containment check has already opened the fd, the path itself is
    // swapped for a symlink escaping the session directory (toward the "not this session's"
    // secret file created above).
    rmSync(swapFile);
    symlinkSync(join(runtime, "secret.txt"), swapFile);

    const chunks: Buffer[] = [];
    for await (const chunk of found.value.handle.createReadStream()) {
      chunks.push(chunk as Buffer);
    }
    // Reading the already-open fd must still return the original content — the swap must not be
    // able to redirect the read to the escaping target.
    expect(Buffer.concat(chunks).toString()).toBe(original);

    await found.value.handle.close();
  });
});
