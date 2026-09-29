import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainScope } from "@bayon/executors";
import {
  installFakeSecurity,
  type FakeSecurity,
} from "@bayon/executors/testing";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { USAGE, parseCli } from "./cli.js";
import { homeEnvOf } from "./home.js";
import { parseInitCli, runInitCommand, type InitIo } from "./init.js";

// `frm init` on temp homes with a stand-in `security`: the real Keychain and
// ~/.foreman are never touched. Ports come from an injected probe, so no real port is needed.

let root: string;
let kc: FakeSecurity;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "frm-init-"));
  kc = installFakeSecurity(join(root, "kc"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Ran {
  readonly code: number;
  readonly out: string[];
  readonly errs: string[];
}

async function run(
  argv: readonly string[],
  env: Record<string, string>,
  taken: ReadonlySet<number> = new Set(),
  ownerHome?: string,
): Promise<Ran> {
  const cmd = parseInitCli(argv);
  if (!cmd.ok) throw new Error(cmd.error.message);
  const out: string[] = [];
  const errs: string[] = [];
  const io: InitIo = {
    env,
    out: (line) => out.push(line),
    err: (line) => errs.push(line),
    keychain: { bin: kc.bin },
    portFree: async (port) => !taken.has(port),
    ...(ownerHome === undefined ? {} : { ownerHome }),
  };
  return { code: await runInitCommand(cmd.value, io), out, errs };
}

/** The item's path; the home is created first, as the service hashes its real path. */
const itemOf = (home: string) => {
  mkdirSync(home, { recursive: true });
  return join(
    kc.kc,
    `${keychainScope({ FRM_HOME: home }).service}.FRM_API_TOKEN`,
  );
};
const installOf = (home: string): unknown =>
  JSON.parse(readFileSync(join(home, "install.json"), "utf8"));

describe("frm init", () => {
  test("creates the home 0700, a 32-byte token under this home's service, and its ports", async () => {
    const home = join(root, "second");
    const ran = await run(["init"], { FRM_HOME: home });
    expect(ran.errs).toEqual([]);
    expect(ran.code).toBe(0);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    const token = readFileSync(itemOf(home), "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // Never printed, never on a command line: security -i read it from stdin.
    const printed = [...ran.out, ...ran.errs].join("\n");
    expect(printed).not.toContain(token);
    const argv = readFileSync(kc.argv, "utf8");
    expect(argv).not.toContain(token);
    expect(argv).toContain("-i");
    // Only this home's service: never the live install's.
    expect(argv).not.toMatch(/-s foreman /);
    expect(printed).toContain(keychainScope({ FRM_HOME: home }).service);
    // Not the default home: the first free pair past the default install's.
    expect(installOf(home)).toEqual({
      version: 1,
      api: { host: "127.0.0.1", port: 3011 },
      web: { port: 5174 },
    });
    expect(printed).toContain("3011");
    expect(printed).toContain("5174");
  });

  test("the default home keeps 3010 and 5173, as the live install always had", async () => {
    const home = join(root, "owner");
    mkdirSync(home);
    const ran = await run(["init"], { FRM_HOME: home }, new Set(), home);
    expect(ran.code).toBe(0);
    expect(installOf(home)).toEqual({
      version: 1,
      api: { host: "127.0.0.1", port: 3010 },
      web: { port: 5173 },
    });
  });

  test("an existing home others can read is closed to 0700, with a warning", async () => {
    const home = join(root, "open");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const ran = await run(["init"], { FRM_HOME: home });
    expect(ran.code).toBe(0);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(ran.errs.join("\n")).toMatch(/warning: .*0755/);
  });

  test("the owner home stores its token under service foreman (the stand-in security)", async () => {
    const owner = join(root, "dot-foreman-owner");
    mkdirSync(owner);
    const ran = await run(["init"], { FRM_HOME: owner }, new Set(), owner);
    expect(ran.code).toBe(0);
    const token = readFileSync(join(kc.kc, "foreman.FRM_API_TOKEN"), "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(kc.argv, "utf8")).toContain(
      "-s foreman -a FRM_API_TOKEN",
    );
    expect(ran.out.join("\n")).toContain("service foreman,");
    expect(ran.out.join("\n")).not.toContain(token);
  });

  test("a second run changes nothing and says so", async () => {
    const home = join(root, "again");
    await run(["init"], { FRM_HOME: home });
    const token = readFileSync(itemOf(home), "utf8");
    const install = readFileSync(join(home, "install.json"), "utf8");
    const again = await run(["init"], { FRM_HOME: home }, new Set([3011]));
    expect(again.code).toBe(0);
    expect(readFileSync(itemOf(home), "utf8")).toBe(token);
    expect(readFileSync(join(home, "install.json"), "utf8")).toBe(install);
    expect(again.out.join("\n")).toMatch(/kept/);
  });

  test("taken ports are skipped", async () => {
    const home = join(root, "busy");
    const ran = await run(
      ["init"],
      { FRM_HOME: home },
      new Set([3011, 3012, 5174]),
    );
    expect(ran.code).toBe(0);
    expect(installOf(home)).toMatchObject({
      api: { port: 3013 },
      web: { port: 5175 },
    });
  });

  test("--api-port and --web-port set them, and change an existing file", async () => {
    const home = join(root, "flags");
    await run(["init"], { FRM_HOME: home });
    const ran = await run(
      ["init", "--api-port", "4010", "--web-port", "4173"],
      {
        FRM_HOME: home,
      },
    );
    expect(ran.code).toBe(0);
    expect(installOf(home)).toMatchObject({
      api: { port: 4010 },
      web: { port: 4173 },
    });
  });

  test("a port flag keeps the file's host and its expose", async () => {
    const home = join(root, "exposed");
    mkdirSync(home);
    writeFileSync(
      join(home, "install.json"),
      JSON.stringify({
        version: 1,
        api: { host: "0.0.0.0", port: 3011, expose: true },
        web: { port: 5174 },
      }),
    );
    const ran = await run(["init", "--api-port", "3020"], { FRM_HOME: home });
    expect(ran.code).toBe(0);
    expect(installOf(home)).toEqual({
      version: 1,
      api: { host: "0.0.0.0", port: 3020, expose: true },
      web: { port: 5174 },
    });
  });

  test("a stored token is kept, never replaced", async () => {
    const home = join(root, "kept");
    writeFileSync(itemOf(home), "e".repeat(64));
    const ran = await run(["init"], { FRM_HOME: home });
    expect(ran.code).toBe(0);
    expect(readFileSync(itemOf(home), "utf8")).toBe("e".repeat(64));
    expect(readFileSync(kc.argv, "utf8")).not.toContain("add-generic-password");
  });

  test("a stored token too short for the API is refused by name, not replaced", async () => {
    const home = join(root, "short");
    writeFileSync(itemOf(home), "abc");
    const ran = await run(["init"], { FRM_HOME: home });
    expect(ran.code).toBe(1);
    expect(ran.errs.join("\n")).toContain("delete-generic-password");
    expect(ran.errs.join("\n")).not.toContain("abc\n");
    expect(readFileSync(itemOf(home), "utf8")).toBe("abc");
  });

  test("FRM_API_TOKEN in the environment: a notice that it wins", async () => {
    const home = join(root, "env");
    const ran = await run(["init"], {
      FRM_HOME: home,
      FRM_API_TOKEN: "z".repeat(40),
    });
    expect(ran.code).toBe(0);
    expect(ran.errs.join("\n")).toContain("FRM_API_TOKEN");
    expect(ran.errs.join("\n")).not.toContain("z".repeat(40));
  });

  test("no FRM_HOME under FRM_NO_DEFAULT_HOME: main's home resolution refuses, nothing is touched", async () => {
    const home = homeEnvOf({}, { guard: { FRM_NO_DEFAULT_HOME: "1" } });
    expect(home.ok).toBe(false);
    if (!home.ok) expect(home.error.message).toContain("FRM_NO_DEFAULT_HOME");
    expect(readFileSync(kc.argv, "utf8")).toBe("");
  });

  test("the default home, as main resolves it: FRM_HOME set, so init runs on it", async () => {
    const owner = join(root, "dot-foreman");
    const home = homeEnvOf({}, { guard: {}, defaultHome: () => owner });
    expect(home.ok && home.value.defaulted).toBe(owner);
    if (!home.ok) return;
    const ran = await run(
      ["init"],
      home.value.env as Record<string, string>,
      new Set(),
      owner,
    );
    expect(ran.code).toBe(0);
    expect(installOf(owner)).toMatchObject({
      api: { port: 3010 },
      web: { port: 5173 },
    });
  });

  test("the file store: refused, pointing at the host's own tool", async () => {
    const home = join(root, "file");
    const ran = await run(["init"], {
      FRM_HOME: home,
      FRM_SECRET_STORE: "file",
      FRM_SECRETS_DIR: join(root, "secrets"),
    });
    expect(ran.code).toBe(1);
    expect(ran.errs.join("\n")).toContain("secrets.sh");
    expect(existsSync(join(home, "install.json"))).toBe(false);
  });
});

describe("parseInitCli", () => {
  test("flags and their errors", () => {
    expect(parseInitCli(["init"])).toEqual({ ok: true, value: {} });
    expect(parseInitCli(["init", "--api-port", "3011"])).toEqual({
      ok: true,
      value: { apiPort: 3011 },
    });
    for (const bad of [
      ["init", "--api-port", "0"],
      ["init", "--web-port", "x"],
      ["init", "extra"],
      ["init", "--nope"],
    ]) {
      expect(parseInitCli(bad).ok).toBe(false);
    }
  });

  test("frm's parser routes init, and its usage names it", () => {
    expect(parseCli(["init", "--web-port", "5180"])).toEqual({
      ok: true,
      value: { command: "init", options: { webPort: 5180 } },
    });
    expect(USAGE).toContain("frm init");
  });
});
