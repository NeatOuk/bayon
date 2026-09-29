import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Real child processes and signals: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

// run.mjs, the service launcher: tees to Docker's log and FRM_HOME/logs, rotates,
// forwards signals, keeps the exit status.
const RUN = fileURLToPath(new URL("./run.mjs", import.meta.url));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "frm-run-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function child(source: string): string {
  const path = join(home, "child.mjs");
  writeFileSync(path, source);
  return path;
}

test("tees stdout and stderr to the log, rotates it, and keeps the child's exit status", () => {
  // Rotation happens between chunks, so the child pauses after each write: six chunks, not one.
  const script = child(
    `const pause = () => new Promise((resolve) => setTimeout(resolve, 25));\n` +
      `for (let i = 0; i < 6; i += 1) {\n` +
      `  process.stdout.write("x".repeat(99) + "\\n");\n` +
      `  await pause();\n` +
      `}\n` +
      `process.stderr.write("an error line\\n");\nawait pause();\nprocess.exit(3);\n`,
  );
  const r = spawnSync(process.execPath, [RUN, "api", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      FRM_HOME: home,
      FRM_LOG_MAX_BYTES: "250",
      FRM_LOG_KEEP: "2",
    },
  });
  expect(r.status).toBe(3);
  expect(r.stdout.split("\n").filter((l) => l !== "")).toHaveLength(6);
  expect(r.stderr).toContain("an error line");
  const logs = join(home, "logs");
  expect(readFileSync(join(logs, "api.log"), "utf8")).toContain(
    "an error line",
  );
  expect(existsSync(join(logs, "api.log.1"))).toBe(true);
  expect(existsSync(join(logs, "api.log.2"))).toBe(true);
  expect(existsSync(join(logs, "api.log.3"))).toBe(false);
});

test("forwards SIGTERM to the child", async () => {
  const script = child(
    `process.on("SIGTERM", () => { process.stdout.write("term\\n"); process.exit(0); });\n` +
      `process.stdout.write("ready\\n");\nsetInterval(() => undefined, 1000);\n`,
  );
  const launcher = spawn(process.execPath, [RUN, "supervisor", script], {
    env: { ...process.env, FRM_HOME: home },
  });
  let out = "";
  launcher.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes("ready")) launcher.kill("SIGTERM");
  });
  const code = await new Promise<number | null>((resolve) =>
    launcher.on("close", resolve),
  );
  expect(code).toBe(0);
  expect(out).toContain("term");
});

test("refuses a bad name or a missing FRM_HOME", () => {
  const script = child("process.exit(0);\n");
  expect(spawnSync(process.execPath, [RUN, "../x", script]).status).toBe(2);
  const env = { ...process.env };
  delete env.FRM_HOME;
  expect(
    spawnSync(process.execPath, [RUN, "api", script], { env }).status,
  ).toBe(2);
});
