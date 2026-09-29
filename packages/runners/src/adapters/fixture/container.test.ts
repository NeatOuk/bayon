// The fixture in a container's image: the install lines write the bundle byte for byte
// (run here in a real shell), fail the build on any change, and stay Dockerfile-safe; a missing
// bundle says so; an executor that places sessions runs the image's node and program; and the
// bundle runs alone, from a directory with no node_modules to fall back on.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { containerReadiness } from "@bayon/core";
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type Executor,
} from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import type { SpawnSpec } from "../../adapter.js";
import { LOADED_PROCESS_BUDGETS } from "../../conformance/fixtures.js";
import {
  FIXTURE_COMMAND,
  createFixtureAdapter,
  fixtureCommand,
} from "./adapter.js";
import {
  FIXTURE_BUNDLE,
  FIXTURE_IMAGE_COMMAND,
  FIXTURE_IMAGE_PROGRAM,
  INSTALL_CHUNK,
  fixtureContainerDefaults,
  installLines,
} from "./container.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-fixture-image-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const dir = (name: string): string => {
  const path = join(root, `${name}-${++dirs}`);
  mkdirSync(path, { recursive: true });
  return path;
};

/** One Dockerfile RUN line as image.ts takes it (its INSTALL rule): no line break, no `\`. */
const ONE_LINE = /^[^\r\n\\]+$/;
/** What the image's /bin/sh has: coreutils, gzip. */
const sh = (line: string): Buffer =>
  execFileSync("/bin/sh", ["-c", line], {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: "pipe",
  });

const spec = (): SpawnSpec => ({
  sessionId: "01SESSION",
  cwd: dir("cwd"),
  homeDir: dir("home"),
  env: {},
  model: "fixture-model",
  flags: {},
});

describe("installLines", () => {
  // Incompressible, so it spills over several lines.
  const bundle = randomBytes(200_000);

  test("each is one Dockerfile-safe line under 64 KiB, and their chunks decode to the bundle", () => {
    const lines = installLines(bundle, "/x/program.mjs");
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) {
      expect(line).toMatch(ONE_LINE);
      // Room for the RUN prefix image.ts adds.
      expect(line.length).toBeLessThan(64 * 1024 - 128);
    }
    const chunks = lines
      .slice(1, -1)
      .map(
        (line) =>
          /^printf %s ([A-Za-z0-9+/=]+) >> \/x\/program\.mjs\.gz\.b64$/.exec(
            line,
          )?.[1] ?? "",
      );
    expect(chunks.every((c) => c !== "" && c.length <= INSTALL_CHUNK)).toBe(
      true,
    );
    expect(gunzipSync(Buffer.from(chunks.join(""), "base64"))).toEqual(bundle);
  });

  test("run in a shell, they write the bundle byte for byte and leave nothing staged", () => {
    const target = join(dir("ok"), "fixture", "program.mjs");
    for (const line of installLines(bundle, target)) sh(line);
    expect(readFileSync(target)).toEqual(bundle);
    expect(existsSync(`${target}.gz.b64`)).toBe(false);
  });

  test("a chunk changed on the way fails the last line, so the image build stops", () => {
    const target = join(dir("bad"), "program.mjs");
    const lines = installLines(bundle, target);
    const flip = (line: string) =>
      line.replace(
        /^(printf %s .{40})(.)/,
        (_, head: string, c: string) => `${head}${c === "A" ? "B" : "A"}`,
      );
    const upToLast = lines.slice(0, -1).map((l, i) => (i === 1 ? flip(l) : l));
    for (const line of upToLast) sh(line);
    expect(() => sh(lines.at(-1) ?? "")).toThrow();
  });

  test("a target that is not a plain absolute path is refused: it rides the lines unquoted", () => {
    for (const target of [
      "relative/program.mjs",
      "/x/a b.mjs",
      "/x/$(id).mjs",
      "/x/'q'.mjs",
      "/x/../etc/p.mjs",
      "/x//p.mjs",
    ]) {
      expect(() => installLines(Buffer.from("x"), target), target).toThrow(
        /plain absolute path/,
      );
    }
  });

  test("the default target is the image's program", () => {
    expect(installLines(Buffer.from("x")).at(-1)).toContain(
      `| gunzip > ${FIXTURE_IMAGE_PROGRAM} &&`,
    );
  });
});

describe("fixtureContainerDefaults", () => {
  test("the bundle's install lines; without a bundle, why the fixture is not container-ready", () => {
    const bytes = Buffer.from("console.log(1)\n");
    expect(fixtureContainerDefaults(() => bytes)).toEqual({
      containerInstall: installLines(bytes),
    });
    expect(
      fixtureContainerDefaults(() => {
        throw new Error("ENOENT: no such file");
      }),
    ).toEqual({
      containerUnready:
        "its program bundle is not built (run pnpm -w build): ENOENT: no such file",
    });
  });

  test("the build wrote the bundle, so the registered fixture is container-ready", () => {
    expect(existsSync(FIXTURE_BUNDLE)).toBe(true);
    const { defaults } = createFixtureAdapter().registration().runner;
    expect(containerReadiness(defaults)).toEqual({ ready: true });
  });
});

describe("the launch", () => {
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });

  /** An executor that records each argv and refuses to run it; `place` gives it placeSession. */
  function recording(place: boolean): {
    readonly ex: Executor;
    readonly argvs: Argv[];
  } {
    const argvs: Argv[] = [];
    const ex: Executor = {
      id: "rec",
      kind: place ? "container" : "local",
      capabilities: { pty: false },
      prepare: (s) => local.prepare(s),
      exec: async (argv) => {
        argvs.push(argv);
        throw new Error("recorded, not run");
      },
      pty: (argv, o) => local.pty(argv, o),
      health: (limits) => local.health(limits),
      probe: (ref) => local.probe(ref),
      cleanup: (ref, mode) => local.cleanup(ref, mode),
      capacity: () => local.capacity(),
      ...(place
        ? {
            placeSession: (sid: string) => ({
              root: `/frm/s/${sid}`,
              home: `/frm/s/${sid}/.frm/home`,
              tmp: `/frm/s/${sid}/.frm/tmp`,
            }),
          }
        : {}),
    };
    return { ex, argvs };
  }

  test("a session an executor places runs the image's node, from PATH, on the image's program", async () => {
    expect(FIXTURE_IMAGE_COMMAND).toEqual([
      "node",
      "/opt/frm/runners/fixture/program.mjs",
    ]);
    const { ex, argvs } = recording(true);
    expect(fixtureCommand(ex)).toBe(FIXTURE_IMAGE_COMMAND);
    const spawned = await createFixtureAdapter().spawn(spec(), ex);
    expect(spawned).toMatchObject({
      ok: false,
      error: { class: "spawn_failed" },
    });
    const [argv] = argvs;
    expect(argv?.slice(0, 3)).toEqual([
      "node",
      "/opt/frm/runners/fixture/program.mjs",
      "--spec",
    ]);
    expect(argv?.join(" ")).not.toContain(process.execPath);
  });

  test("anywhere else it runs this host's node on this checkout's program, as before", async () => {
    const { ex, argvs } = recording(false);
    expect(fixtureCommand(ex)).toBe(FIXTURE_COMMAND);
    expect(FIXTURE_COMMAND[0]).toBe(process.execPath);
    await createFixtureAdapter().spawn(spec(), ex);
    expect(argvs[0]?.slice(0, FIXTURE_COMMAND.length)).toEqual([
      ...FIXTURE_COMMAND,
    ]);
  });

  test("an explicit command wins on every executor", async () => {
    const { ex, argvs } = recording(true);
    await createFixtureAdapter({ command: ["my-fixture"] }).spawn(spec(), ex);
    expect(argvs[0]?.[0]).toBe("my-fixture");
  });

  test(
    "the bundle runs alone: copied where no node_modules is, a send ends in a terminal",
    { timeout: 20_000 },
    async () => {
      const copy = join(dir("alone"), "program.mjs");
      copyFileSync(FIXTURE_BUNDLE, copy);
      const adapter = createFixtureAdapter({
        command: [process.execPath, copy],
        graceMs: LOADED_PROCESS_BUDGETS.graceMs,
      });
      const s = spec();
      const started = await adapter.spawn(s, local);
      if (!started.ok) throw new Error(started.error.message);
      const h = started.value;
      const records = adapter.records(h)[Symbol.asyncIterator]();
      await adapter.send(h, { runId: "r1", text: "go", promptPath: "/p" });
      const kinds: unknown[] = [];
      while (!kinds.includes("terminal")) {
        const next = await records.next();
        if (next.done === true) break;
        kinds.push(
          (
            JSON.parse(new TextDecoder().decode(next.value.bytes)) as {
              kind?: unknown;
            }
          ).kind,
        );
      }
      expect(kinds[0]).toBe("session_init");
      expect(kinds.at(-1)).toBe("terminal");
      expect(readFileSync(join(s.cwd, "README.md"), "utf8")).toBe(
        "fixture was here\n",
      );
      await adapter.stop(h, "graceful");
      expect(await h.exited).toMatchObject({ code: 0 });
    },
  );
});
