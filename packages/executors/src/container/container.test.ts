// The container executor over a loopback transport (the local shell) and a stand-in docker: the
// whole executor but ssh and docker themselves, which container.live.test.ts covers on the host.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { describeExecutorContract, readAll, within } from "../contract.js";
import { SlotCounter } from "../slots.js";
import type { Argv } from "../types.js";
import type { ContainerExecutorConfigInput } from "./config.js";
import { ContainerExecutor } from "./container.js";
import { FAKE_IMAGE_ID, installFakeDocker } from "./fake-docker.js";
import { LoopbackTransport } from "./loopback.js";
import type { ExecutorDiagnostic } from "./proc.js";
import { mintToken, parseRef } from "./ref.js";
import type { ContainerPaths } from "./route.js";

const ID = "ctr-loop";
const node = (source: string): Argv => [process.execPath, "-e", source];
const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-ctr-")));
const root = join(base, "remote");
// One "container" per session, whose paths are this machine's: exec runs the shim directly.
const { env: ENV, state } = installFakeDocker(base, ID);
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PATHS: ContainerPaths = {
  sessions: join(root, "work"),
  run: join(root, "run"),
  shim: "/opt/frm/exec-shim.mjs",
};

const CONFIG: ContainerExecutorConfigInput = {
  ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
  remote_root: root,
  image: "frm/test",
  min_free_pct: 0,
  heartbeat_ms: 200,
  kill_grace_ms: 1_000,
};

function executor(
  o: {
    readonly slots?: SlotCounter;
    readonly config?: Partial<ContainerExecutorConfigInput>;
    readonly onDiagnostic?: (d: ExecutorDiagnostic) => void;
    readonly egressHosts?: readonly string[];
  } = {},
): ContainerExecutor {
  return new ContainerExecutor({
    id: ID,
    slots: o.slots ?? new SlotCounter(2),
    frmHome: base,
    config: { ...CONFIG, ...o.config },
    transport: new LoopbackTransport(ENV),
    paths: PATHS,
    ...(o.egressHosts === undefined ? {} : { egressHosts: o.egressHosts }),
    ...(o.onDiagnostic === undefined ? {} : { onDiagnostic: o.onDiagnostic }),
  });
}

describeExecutorContract(
  "container (loopback)",
  () => {
    const slots = new SlotCounter(2);
    return {
      slots,
      executor: executor({ slots }),
      programs: {
        cat: node("process.stdin.pipe(process.stdout)"),
        interleave: node(`
          const rl = require("node:readline").createInterface({ input: process.stdin });
          const acks = rl[Symbol.asyncIterator]();
          (async () => {
            for (const [line, out] of [[1, process.stdout], [2, process.stderr], [3, process.stdout], [4, process.stderr]]) {
              out.write(line + "\\n");
              await acks.next();
            }
            rl.close();
            process.stdin.destroy();
          })();`),
        whereami: node(
          'process.stdout.write([process.cwd(), process.env.FOO, process.env.HOME ?? "-", ""].join("\\n"))',
        ),
        exit3: node("process.exit(3)"),
        forever: node("setInterval(() => {}, 1 << 30)"),
        missing: ["/nonexistent/frm-no-such-program"],
        ptyEcho: node("0"),
      },
    };
  },
  {
    workdir: async () => {
      const dir = join(root, "run", `contract-${mintToken()}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    removeWorkdir: async (dir) => rmSync(dir, { recursive: true, force: true }),
    sessionRoot: (_dir, id) => join(root, "work", id),
  },
);

describe("ContainerExecutor (loopback)", { timeout: 15_000 }, () => {
  const forever = node("setInterval(() => {}, 1 << 30)");

  test("declares no pty, and refuses one", async () => {
    const ex = executor();
    expect(ex.kind).toBe("container");
    expect(ex.capabilities).toEqual({ pty: false });
    await expect(ex.pty()).rejects.toMatchObject({ class: "validation" });
  });

  test("an invalid config_json is refused at construction", () => {
    expect(() =>
      executor({ config: { remote_root: "/home/ops frm; rm -rf ~" } }),
    ).toThrow();
    let caught: unknown;
    try {
      executor({ config: { image: "$(reboot)" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ class: "validation" });
  });

  describe("reloadConfig: the row's image reaches a running executor", () => {
    test("a new tag is adopted, and everything after it uses that tag", async () => {
      const ex = executor();
      expect(ex.reloadConfig({ ...CONFIG, image: "frm/test:next" })).toBe(
        "image frm/test → frm/test:next",
      );
      const report = await ex.health({
        minFreePct: 0,
        clockSkewMaxMs: 60_000,
      });
      expect(report.detail.image).toBe("frm/test:next");
    });

    test("a row that says nothing new adopts nothing", async () => {
      const ex = executor();
      expect(ex.reloadConfig({ ...CONFIG })).toBeNull();
      const report = await ex.health({
        minFreePct: 0,
        clockSkewMaxMs: 60_000,
      });
      expect(report.detail.image).toBe("frm/test");
    });

    // Null used to mean both "nothing changed" and "I could not read the row", so
    // an operator's edit the supervisor ignores said nothing at all, on any pass, forever.
    test.each([
      ["a config that does not parse", { ...CONFIG, image: "$(reboot)" }],
      ["nothing of the kind", { nope: 1 }],
    ])("%s is reported, not passed over in silence", async (_, config) => {
      const ex = executor();
      expect(ex.reloadConfig(config)).toMatch(/cannot parse/);
      const report = await ex.health({
        minFreePct: 0,
        clockSkewMaxMs: 60_000,
      });
      expect(report.detail.image).toBe("frm/test");
    });

    // The gateway's digest is over the image *and* the allowlist. `frm executor
    // image` starts a gateway on the row's allowlist; a supervisor adopting only the image tore
    // that one down on its next ensureGateway() and put back one on its boot-time allowlist —
    // reverting an egress control while the operator's terminal said the new one was applied.
    test("the row's egress_allow is adopted with the image", () => {
      const ex = executor({
        config: { egress_allow: ["old.example.com"] },
        egressHosts: ["runner.example.com"],
      });
      expect(
        ex.reloadConfig({ ...CONFIG, egress_allow: ["new.example.com"] }),
      ).toBe(
        "egress allow old.example.com,runner.example.com → new.example.com,runner.example.com",
      );
      // Sorted and deduplicated, and the runners' own hosts survive a row that repeats one.
      expect(
        ex.reloadConfig({
          ...CONFIG,
          egress_allow: ["new.example.com", "runner.example.com"],
        }),
      ).toBeNull();
      expect(
        ex.reloadConfig({
          ...CONFIG,
          image: "frm/test:next",
          egress_allow: [],
        }),
      ).toBe(
        "image frm/test → frm/test:next; egress allow new.example.com,runner.example.com → runner.example.com",
      );
    });

    test("nothing else is adopted: the ssh master and tunnel are already open on it", async () => {
      const ex = executor();
      expect(
        ex.reloadConfig({
          ...CONFIG,
          image: "frm/test:next",
          remote_root: "/somewhere/else",
        }),
      ).toBe("image frm/test → frm/test:next");
      const report = await ex.health({
        minFreePct: 0,
        clockSkewMaxMs: 60_000,
      });
      expect(report.detail.disk).toMatchObject([{ path: root }]);
    });
  });

  // On a container this id is the only pin a certification has, so a read that
  // answers null with nothing said is a certification that pins nothing and can never lapse, with
  // no warning anywhere. Every path to null now leaves a diagnostic.
  describe("imageIdentity: a null is never silent", () => {
    test("the id the host holds the configured image under", async () => {
      const seen: ExecutorDiagnostic[] = [];
      const ex = executor({ onDiagnostic: (d) => seen.push(d) });
      expect(await ex.imageIdentity()).toBe(FAKE_IMAGE_ID);
      expect(seen).toEqual([]);
    });

    test("an unreadable image is null and diagnosed", async () => {
      const seen: ExecutorDiagnostic[] = [];
      const ex = new ContainerExecutor({
        id: ID,
        slots: new SlotCounter(1),
        frmHome: base,
        config: { ...CONFIG, image: "frm/absent" },
        // A transport whose docker says nothing usable: the host answering nothing at all.
        transport: new LoopbackTransport({ ...ENV, PATH: "/nonexistent" }),
        paths: PATHS,
        onDiagnostic: (d) => seen.push(d),
      });
      expect(await ex.imageIdentity()).toBeNull();
      expect(seen).toMatchObject([
        { kind: "image_unreadable", ref: "frm/absent" },
      ]);
    });
  });

  test("prepare derives remote_root/work/<sid> from the session id, and reuses a running container", async () => {
    const ex = executor();
    // The supervisor names the root in its own FRM_HOME; the executor derives its own.
    expect(
      await ex.prepare({
        sessionId: "ses-9",
        root: "/local/frm-home/work/ses-9",
      }),
    ).toEqual({ root: join(PATHS.sessions, "ses-9") });
    expect(existsSync(join(root, "work", "ses-9"))).toBe(true);
    await expect(
      ex.prepare({ sessionId: "ses-2", root: "work/ses-2" }),
    ).rejects.toMatchObject({ class: "validation" });
    await expect(
      ex.prepare({ sessionId: "bad id", root: join(root, "work", "bad id") }),
    ).rejects.toMatchObject({ class: "validation" });
    const first = await ex.prepare({
      sessionId: "ses-2",
      root: join(root, "work", "ses-2"),
    });
    const container = readFileSync(join(state, "ses-2"), "utf8");
    const again = await executor().prepare({
      sessionId: "ses-2",
      root: join(root, "work", "ses-2"),
    });
    expect(again).toEqual(first);
    expect(readFileSync(join(state, "ses-2"), "utf8")).toBe(container);
    expect(existsSync(join(root, "work", "ses-2"))).toBe(true);
  });

  test("a full disk refuses admission, retryably", async () => {
    const ex = executor({ config: { min_free_pct: 100 } });
    await expect(
      ex.prepare({ sessionId: "ses-3", root: join(root, "work", "ses-3") }),
    ).rejects.toMatchObject({ class: "admission_refused", retryable: true });
  });

  test("exec into a session nobody prepared is spawn_failed; a host chore into a session is refused", async () => {
    const ex = executor();
    await expect(
      ex.exec(forever, { cwd: join(root, "work", "never"), env: {} }),
    ).rejects.toMatchObject({ class: "spawn_failed" });
    await expect(
      ex.exec(["cat", join(root, "work", "ses-2", "f")], {
        cwd: join(root, "run"),
        env: {},
      }),
    ).rejects.toMatchObject({ class: "validation" });
  });

  test("a megabyte of stdin crosses the credit window intact", async () => {
    const ex = executor({ config: { window_bytes: 64 * 1024 } });
    const proc = await ex.exec(node("process.stdin.pipe(process.stdout)"), {
      cwd: join(root, "run"),
      env: {},
    });
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i += 1) input[i] = i % 251;
    const output = readAll(proc.stdout);
    await proc.stdin?.write(input);
    await proc.stdin?.end();
    const text = await within(output, "echo");
    expect(Buffer.from(text, "utf8").length).toBeGreaterThan(0);
    expect(await within(proc.exited, "exit")).toEqual({
      code: 0,
      signal: null,
    });
    await expect(proc.stdin?.write("late")).rejects.toMatchObject({
      class: "internal",
    });
  });

  test("a container program: probe, cleanup(hard), refs of other executors refused", async () => {
    const ex = executor();
    const prepared = await ex.prepare({
      sessionId: "ses-4",
      root: join(root, "work", "ses-4"),
    });
    const proc = await ex.exec(forever, { cwd: prepared.root, env: {} });
    expect(parseRef(proc.ref, ID).container).toMatch(/^[0-9a-f]{12}$/);
    expect(await ex.probe(proc.ref)).toBe("alive");
    await ex.cleanup(proc.ref, "hard");
    expect(await within(proc.exited, "cleanup")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(await ex.probe(proc.ref)).toBe("dead");
    const foreign = proc.ref.replace(`ctr:${ID}:`, "ctr:ctr-other:");
    await expect(ex.probe(foreign)).rejects.toMatchObject({
      class: "validation",
    });
    await expect(ex.cleanup(foreign, "soft")).rejects.toMatchObject({
      class: "validation",
    });
  });

  test("a restarted supervisor probes and cleans up a ref it did not start", async () => {
    const first = executor();
    const proc = await first.exec(forever, { cwd: join(root, "run"), env: {} });
    const second = executor();
    expect(await second.probe(proc.ref)).toBe("alive");
    await second.cleanup(proc.ref, "soft");
    expect(await within(proc.exited, "cleanup")).toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(await second.probe(proc.ref)).toBe("dead");
  });

  test("a channel lost before the exit frame settles SIGKILL and signals the group out of band", async () => {
    const seen: ExecutorDiagnostic[] = [];
    const ex = executor({ onDiagnostic: (d) => seen.push(d) });
    const proc = await ex.exec(forever, { cwd: join(root, "run"), env: {} });
    const { token } = parseRef(proc.ref, ID);
    const record = JSON.parse(
      readFileSync(join(root, "run", `${token}.json`), "utf8"),
    ) as { shimPid: number; pgid: number };
    process.kill(record.shimPid, "SIGKILL");
    expect(await within(proc.exited, "lost")).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(seen.map((d) => d.kind)).toContain("lost");
    await vi.waitFor(
      () => {
        expect(() => process.kill(record.pgid, 0)).toThrow();
      },
      { timeout: 5_000, interval: 20 },
    );
  });

  test("usage reports free disk and per-session bytes; stats a round-trip time", async () => {
    const ex = executor();
    await ex.prepare({ sessionId: "ses-5", root: join(root, "work", "ses-5") });
    writeFileSync(join(root, "work", "ses-5", "blob"), Buffer.alloc(64 * 1024));
    const usage = await ex.usage();
    expect(usage.freePct).toBeGreaterThan(0);
    expect(usage.freePct).toBeLessThanOrEqual(100);
    expect(
      usage.sessions.find((s) => s.sessionId === "ses-5")?.bytes,
    ).toBeGreaterThanOrEqual(64 * 1024);
    expect(ex.stats().rttMs).toEqual(expect.any(Number));
    await ex.close();
  });
});

describe("placement surface (loopback)", { timeout: 15_000 }, () => {
  test("places a session's root, home and tmp in its one mount, with the image's PATH", () => {
    const ex = executor();
    const root = join(PATHS.sessions, "ses-p");
    expect(ex.placeSession("ses-p")).toEqual({
      root,
      home: join(root, ".frm", "home"),
      tmp: join(root, ".frm", "tmp"),
    });
    expect(ex.envPath).toBe(
      "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );
    expect(() => ex.placeSession("a b")).toThrow();
    expect(ex.mirrors.path("repo_1")).toBe(
      join(dirname(PATHS.sessions), "mirror", "repo_1.git"),
    );
  });

  test("lists the sessions holding a container; releases one by label, keeping or removing its root", async () => {
    const ex = executor();
    await ex.prepare({ sessionId: "ses-r1", root: "/x/work/ses-r1" });
    await ex.prepare({ sessionId: "ses-r2", root: "/x/work/ses-r2" });
    const sessions = async () => (await ex.listOwned()).map((o) => o.sessionId);
    expect(await ex.listOwned()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "container", sessionId: "ses-r1" }),
        expect.objectContaining({ kind: "container", sessionId: "ses-r2" }),
      ]),
    );
    await ex.release("ses-r1", { root: "keep" });
    expect(await sessions()).not.toContain("ses-r1");
    expect(existsSync(join(PATHS.sessions, "ses-r1"))).toBe(true);
    await ex.release("ses-r2", { root: "remove" });
    expect(await sessions()).not.toContain("ses-r2");
    expect(existsSync(join(PATHS.sessions, "ses-r2"))).toBe(false);
    await expect(ex.release("a b", { root: "keep" })).rejects.toMatchObject({
      class: "validation",
    });
  });
});
