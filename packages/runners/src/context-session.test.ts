// What every compressing adapter refuses before anything starts (spec M12), and a
// session's proxy once it may.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_RULESET, CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import type { SpawnSpec } from "./adapter.js";
import type { ContextTransform } from "./context-rewrite.js";
import {
  CONTEXT_PROXY_WARNING,
  compressionRefusal,
  startSessionProxy,
  writableRoots,
  type CompressesContext,
} from "./context-session.js";

/** A session root: its worktree and home inside, the store beside them. */
const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-ctx-session-")));
const cwd = join(root, "work");
mkdirSync(cwd);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOTHING: ContextTransform = {
  route: () => undefined,
  mayHold: () => false,
  rewrite: (b) => b,
};
/** An adapter that declares compression on local executors, as both real ones do. */
const LOCAL_ONLY: CompressesContext = (ex) => ex.kind === "local";

const spec = (
  env: Record<string, string> = {},
  c: Partial<NonNullable<SpawnSpec["contextCompression"]>> = {},
  o: Partial<SpawnSpec> = {},
): SpawnSpec => ({
  sessionId: "01CTX",
  cwd,
  homeDir: join(root, "home"),
  env,
  model: "m",
  flags: {},
  contextCompression: {
    ruleset: CONTEXT_RULESET,
    storeDir: join(root, CONTEXT_STORE_DIR),
    token: randomBytes(32).toString("hex"),
    ...c,
  },
  ...o,
});

const local = { kind: "local" } as const;
const refusal = (s: SpawnSpec, ex = local as { kind: "local" | "container" }) =>
  compressionRefusal(s, ex, LOCAL_ONLY)?.message;

test("the adapter's own declaration is what is enforced", () => {
  expect(refusal(spec())).toBeUndefined();
  const { contextCompression: _, ...off } = spec();
  void _;
  expect(refusal(off, { kind: "container" })).toBeUndefined();
  expect(refusal(spec(), { kind: "container" })).toMatch(
    /does not compress context on a container executor/,
  );
  // Whatever it declares: one that declares nothing is refused everywhere.
  expect(compressionRefusal(spec(), local, () => false)?.message).toMatch(
    /does not compress context on a local executor/,
  );
});

test("refused: another ruleset, an egress proxy in the env", () => {
  expect(refusal(spec({}, { ruleset: "ctx0" }))).toMatch(
    /"ctx0" is not this build's/,
  );
  expect(
    refusal(spec({ https_proxy: "http://proxy:3128", NO_PROXY: "x" })),
  ).toMatch(/egress proxy \(https_proxy\)/);
  expect(refusal(spec({ HTTP_PROXY: "" }))).toBeUndefined();
});

test("refused: a store any root the session writes could reach", () => {
  const inside = /inside a root the session writes/;
  expect(refusal(spec({}, { storeDir: join(cwd, CONTEXT_STORE_DIR) }))).toMatch(
    inside,
  );
  expect(
    refusal(spec({}, { storeDir: join(root, "home", CONTEXT_STORE_DIR) })),
  ).toMatch(inside);
  const extra = join(root, "extra");
  expect(
    refusal(
      spec(
        {},
        { storeDir: join(extra, CONTEXT_STORE_DIR) },
        { extraRoots: [extra] },
      ),
    ),
  ).toMatch(inside);
  expect(refusal(spec({}, { storeDir: join(root, "ctx") }))).toMatch(
    /must end in \.foreman\/ctx/,
  );
  expect(writableRoots(spec({}, {}, { extraRoots: [extra] }))).toEqual([
    cwd,
    extra,
    join(root, "home"),
  ]);
});

test("off: no proxy; on: a proxy on loopback", async () => {
  const { contextCompression: _, ...off } = spec();
  void _;
  const o = {
    compresses: LOCAL_ONLY,
    transform: NOTHING,
    upstream: "http://127.0.0.1:9",
  };
  expect(await startSessionProxy(off, local, o)).toEqual({
    ok: true,
    value: undefined,
  });
  const on = spec();
  const started = await startSessionProxy(on, local, {
    ...o,
    log: () => undefined,
  });
  if (!started.ok || started.value === undefined) throw new Error("no proxy");
  expect(started.value.url).toBe(`http://127.0.0.1:${started.value.port}`);
  expect(started.value.token).toBe(on.contextCompression?.token);
  await started.value.close();
  await started.value.close(); // idempotent
  const refused = await startSessionProxy(spec(), { kind: "remote" }, o);
  expect(refused.ok ? "started" : refused.error.class).toBe("validation");
  const badToken = await startSessionProxy(spec({}, { token: "x" }), local, o);
  expect(badToken.ok ? "started" : badToken.error.message).toMatch(/bearer/);
});

test("by default an event is a process warning naming the session, never a request's content", async () => {
  const warned = Promise.withResolvers<Error>();
  const listen = (w: Error) => {
    if (w.name === CONTEXT_PROXY_WARNING) warned.resolve(w);
  };
  process.on("warning", listen);
  try {
    const started = await startSessionProxy(spec(), local, {
      compresses: LOCAL_ONLY,
      transform: NOTHING,
      upstream: "http://127.0.0.1:9",
    });
    if (!started.ok || started.value === undefined) throw new Error("no proxy");
    await fetch(`${started.value.url}/v1/x`, {
      headers: { authorization: "Bearer secret-value-never-logged" },
    });
    const w = await warned.promise;
    expect(w.message).toBe("session 01CTX: unauthorized");
    await started.value.close();
  } finally {
    process.off("warning", listen);
  }
});
