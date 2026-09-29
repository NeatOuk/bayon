import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { SUPERVISOR_LOCK_FILE } from "@bayon/core";
import { readProc } from "@bayon/executors";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COMMANDS, USAGE, parseCli } from "./cli.js";
import { logTail } from "./start.js";
import {
  checkNotRunning,
  checkToken,
  repoRootOf,
  startPlan,
  type StartPlan,
} from "./start-plan.js";

// `frm start`: what it would run, planned on a temp home. No process is started, and
// the Keychain is never asked: a token comes from the env, or a session's env forbids the store.

const REPO = "/repo";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-start-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const writeInstall = (api: number, web: number): void =>
  writeFileSync(
    join(home, "install.json"),
    JSON.stringify({
      version: 1,
      api: { host: "127.0.0.1", port: api },
      web: { port: web },
    }),
  );

describe("startPlan", () => {
  test("starts the supervisor, then the API, then the GUI, each with FRM_HOME and its own log", () => {
    const plan = startPlan({ FRM_HOME: home, PATH: "/bin" }, REPO);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.children.map((c) => c.name)).toEqual([
      "supervisor",
      "api",
      "web",
    ]);
    expect(plan.value.children.map((c) => c.args)).toEqual([
      ["/repo/apps/supervisor/dist/main.js"],
      ["/repo/apps/api/dist/main.js"],
      ["/repo/apps/web/node_modules/vite/bin/vite.js"],
    ]);
    expect(plan.value.children.map((c) => c.cwd)).toEqual([
      REPO,
      REPO,
      "/repo/apps/web",
    ]);
    expect(plan.value.children.map((c) => c.log)).toEqual(
      ["supervisor", "api", "web"].map((n) => join(home, "logs", `${n}.log`)),
    );
    expect(plan.value.env).toMatchObject({ FRM_HOME: home, PATH: "/bin" });
    expect(plan.value.migrate).toEqual(["/repo/packages/db/dist/cli.js", "up"]);
  });

  test("with no install file: the default ports", () => {
    const plan = startPlan({ FRM_HOME: home }, REPO);
    expect(plan.ok && plan.value.healthUrl).toBe(
      "http://127.0.0.1:3010/api/v1/health",
    );
    expect(plan.ok && plan.value.guiUrl).toBe("http://localhost:5173");
  });

  test("the home's install.json picks the ports", () => {
    writeInstall(3011, 5174);
    const plan = startPlan({ FRM_HOME: home }, REPO);
    expect(plan.ok && plan.value.healthUrl).toBe(
      "http://127.0.0.1:3011/api/v1/health",
    );
    expect(plan.ok && plan.value.guiUrl).toBe("http://localhost:5174");
  });

  test("the env's ports still win over the file", () => {
    writeInstall(3011, 5174);
    const plan = startPlan(
      { FRM_HOME: home, FRM_API_PORT: "3020", FRM_WEB_PORT: "5180" },
      REPO,
    );
    expect(plan.ok && plan.value.healthUrl).toBe(
      "http://127.0.0.1:3020/api/v1/health",
    );
    expect(plan.ok && plan.value.guiUrl).toBe("http://localhost:5180");
  });

  test("refuses an unreadable install file", () => {
    writeFileSync(join(home, "install.json"), "not json");
    const plan = startPlan({ FRM_HOME: home }, REPO);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.error.message).toMatch(/is not JSON/);
  });

  test("refuses FRM_DB without FRM_HOME", () => {
    const plan = startPlan({ FRM_DB: join(home, "foreman.db") }, REPO);
    expect(!plan.ok && plan.error.message).toBe(
      "frm start needs FRM_HOME (FRM_DB alone is not enough)",
    );
  });

  test("refuses with no home", () => {
    const plan = startPlan({}, REPO);
    expect(!plan.ok && plan.error.message).toBe(
      "no Bayon home was found: set FRM_HOME, or run pnpm frm init",
    );
  });

  test("a relative home is resolved before it reaches a child", () => {
    const plan = startPlan({ FRM_HOME: "rel-home" }, REPO);
    expect(plan.ok && plan.value.env["FRM_HOME"]).toBe(
      join(process.cwd(), "rel-home"),
    );
  });
});

describe("checkToken", () => {
  test("a token in the env is enough", async () => {
    const plan = startPlan(
      { FRM_HOME: home, FRM_API_TOKEN: "t".repeat(32) },
      REPO,
    );
    if (!plan.ok) throw new Error(plan.error.message);
    expect((await checkToken(plan.value)).ok).toBe(true);
  });

  test("no token: points to frm init", async () => {
    // Inside a session the stored token is never read, so this asks no Keychain.
    const plan = startPlan({ FRM_HOME: home, FRM_SESSION_ID: "s1" }, REPO);
    if (!plan.ok) throw new Error(plan.error.message);
    const checked = await checkToken(plan.value);
    expect(!checked.ok && checked.error.message).toBe(
      `${home} has no API token: run pnpm frm init first`,
    );
  });
});

describe("the command", () => {
  test("parses bare, refuses arguments, and has usage", () => {
    expect(parseCli(["start"])).toEqual({
      ok: true,
      value: { command: "start" },
    });
    const extra = parseCli(["start", "now"]);
    expect(!extra.ok && extra.error.message).toMatch(/takes no arguments/);
    expect(parseCli(["start", "--help"])).toEqual({
      ok: true,
      value: { command: "help", topic: "start" },
    });
    expect(COMMANDS["start"]?.usage).toMatch(/Ctrl-C stops all three/);
    expect(USAGE).toMatch(/frm start/);
  });

  test("the repo root is three levels above the built module", () => {
    expect(repoRootOf("file:///x/bayon/tools/frm/dist/start-plan.js")).toBe(
      "/x/bayon",
    );
  });

  test("logTail keeps the last lines", () => {
    expect(logTail("a\nb\nc\nd\n", 2)).toBe("c\nd");
  });
});

describe("checkNotRunning", () => {
  const free = { healthy: async () => false, portFree: async () => true };
  const planOf = (): StartPlan => {
    writeInstall(3011, 5174);
    const plan = startPlan({ FRM_HOME: home }, REPO);
    if (!plan.ok) throw new Error(plan.error.message);
    return plan.value;
  };
  const lock = async (pid: number, startedAt?: number): Promise<void> => {
    const info = await readProc(pid);
    writeFileSync(
      join(home, SUPERVISOR_LOCK_FILE),
      JSON.stringify({
        pid,
        started_at: startedAt ?? (info?.start ?? 0) * 1000,
        host: hostname(),
        acquired_at: 0,
        nonce: "n",
      }),
    );
  };

  test("a quiet home may start", async () => {
    expect((await checkNotRunning(planOf(), free)).ok).toBe(true);
  });

  test("refuses a home whose supervisor lock has a live owner", async () => {
    const plan = planOf();
    await lock(process.pid);
    const checked = await checkNotRunning(plan, free);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error.message).toContain(
      `Bayon is already running on this home (${home}): stop it first, or set FRM_HOME for a second install.`,
    );
    expect(!checked.ok && checked.error.message).toContain(
      `pid ${process.pid}`,
    );
  });

  test("a lock whose owner is gone (the pid now names another start) does not stop it", async () => {
    const plan = planOf();
    await lock(process.pid, 1_000);
    expect((await checkNotRunning(plan, free)).ok).toBe(true);
  });

  test("refuses when the API answers", async () => {
    const checked = await checkNotRunning(planOf(), {
      ...free,
      healthy: async () => true,
    });
    expect(!checked.ok && checked.error.message).toContain(
      "the API answers http://127.0.0.1:3011/api/v1/health",
    );
  });

  test("refuses when the API's or the GUI's port is bound", async () => {
    const plan = planOf();
    const api = await checkNotRunning(plan, {
      ...free,
      portFree: async (port) => port !== 3011,
    });
    expect(!api.ok && api.error.message).toContain(
      "the API's port 3011 is in use",
    );
    const web = await checkNotRunning(plan, {
      ...free,
      portFree: async (port) => port !== 5174,
    });
    expect(!web.ok && web.error.message).toContain(
      "the GUI's port 5174 is in use",
    );
  });
});
