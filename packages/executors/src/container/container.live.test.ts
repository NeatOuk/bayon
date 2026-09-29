// The container executor against a real docker host over ssh. Skipped
// unless FRM_CONTAINER=1:
//   FRM_CONTAINER=1 pnpm exec vitest run packages/executors/src/container/container.live.test.ts
// FRM_CONTAINER_HOST (user@host, required), FRM_CONTAINER_KEY (a 0600 private
// key, default ~/.ssh/id_ed25519), FRM_CONTAINER_IMAGE (default: the host's node:22-trixie-slim
// by image id, run as it is: never tagged, pulled or removed). The host key comes from the
// operator's ~/.ssh/known_hosts, never from a scan. Every container is labelled frm.managed=1 and
// frm.executor=<this run's id>, and removed by that label in afterAll; nothing else is touched.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { describeExecutorContract, within } from "../contract.js";
import { SlotCounter } from "../slots.js";
import type { Argv, ExitStatus } from "../types.js";
import {
  ContainerExecutorConfig,
  type ContainerExecutorConfigInput,
} from "./config.js";
import { ContainerExecutor } from "./container.js";
import type { ExecutorDiagnostic } from "./proc.js";
import { parseRef } from "./ref.js";
import { SshTransport } from "./ssh.js";
import { runRemote, type Ran } from "./transport.js";

const LIVE = process.env["FRM_CONTAINER"] === "1";
const [USER = "", HOST = ""] = (process.env["FRM_CONTAINER_HOST"] ?? "").split(
  "@",
);
if (LIVE && (USER === "" || HOST === ""))
  throw new Error("FRM_CONTAINER=1 needs FRM_CONTAINER_HOST=user@host");
const KEY =
  process.env["FRM_CONTAINER_KEY"] ?? join(homedir(), ".ssh", "id_ed25519");
const IMAGE =
  process.env["FRM_CONTAINER_IMAGE"] ??
  "sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RUN = [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join("");
const ID = `ctr-t${randomBytes(4).toString("hex")}`;
const ROOT = `/home/${USER}/frm/test/${RUN}`;
const ROOT_GUARD = new RegExp(
  `^/home/${USER}/frm/test/[0-9A-HJKMNP-TV-Z]{26}$`,
);
const REMOTE_WAIT = { timeout: 20_000, interval: 250 };

/** Runs on the container and on the docker host alike: dash's default PATH finds node. */
const sh = (source: string): Argv => [
  "/bin/sh",
  "-c",
  `exec node -e '${source}'`,
];
const forever = sh("setInterval(() => {}, 1 << 30)");
const escapees = sh(
  'const { spawn } = require("node:child_process"); spawn("sleep", ["300"], { stdio: "ignore" }); spawn("sleep", ["301"], { stdio: "ignore", detached: true }).unref(); setInterval(() => {}, 1 << 30)',
);

let frmHome = "";
let knownHosts = "";
let transport: SshTransport;

const config = (
  over: Partial<ContainerExecutorConfigInput> = {},
): ContainerExecutorConfigInput => ({
  ssh: {
    host: HOST,
    user: USER,
    identity_ref: `file:${KEY}`,
    known_hosts: knownHosts,
  },
  remote_root: ROOT,
  image: IMAGE,
  network: "none",
  heartbeat_ms: 1_000,
  kill_grace_ms: 2_000,
  ...over,
});

function executor(
  over: Partial<ContainerExecutorConfigInput> = {},
  onDiagnostic?: (d: ExecutorDiagnostic) => void,
): ContainerExecutor {
  return new ContainerExecutor({
    id: ID,
    slots: new SlotCounter(2),
    frmHome,
    config: config(over),
    transport,
    ...(onDiagnostic === undefined ? {} : { onDiagnostic }),
  });
}

const remote = (command: string): Promise<Ran> =>
  runRemote(transport, command, {
    what: "live check",
    signal: AbortSignal.timeout(30_000),
  });
const top = async (container: string): Promise<string> =>
  (await remote(`docker top ${container} -eo pid,args`)).stdout;
const sessionRoot = (id: string) => `${ROOT}/work/${id}`;
const containerOf = (ref: string): string => parseRef(ref, ID).container ?? "";

async function settles(
  promise: Promise<ExitStatus>,
  ms: number,
): Promise<ExitStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`not settled in ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!LIVE)(`container executor on ${HOST}`, () => {
  beforeAll(() => {
    frmHome = mkdtempSync(join(tmpdir(), "frm-live-"));
    const pinned = execFileSync(
      "ssh-keygen",
      ["-F", HOST, "-f", join(homedir(), ".ssh", "known_hosts")],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("#"));
    if (pinned.length === 0)
      throw new Error(`${HOST} is not in ~/.ssh/known_hosts`);
    knownHosts = join(frmHome, "known_hosts");
    writeFileSync(knownHosts, `${pinned.join("\n")}\n`);
    transport = new SshTransport({
      executorId: ID,
      frmHome,
      ssh: ContainerExecutorConfig.parse(config()).ssh,
    });
  });

  afterAll(async () => {
    const labels = `--filter label=frm.managed=1 --filter label=frm.executor=${ID}`;
    await remote(`docker ps -aq ${labels} | xargs -r docker rm -f`);
    if (!ROOT_GUARD.test(ROOT)) throw new Error(`refusing to remove ${ROOT}`);
    await remote(`rm -rf ${ROOT}`);
    const left = await remote(`docker ps -aq ${labels}`);
    await transport.close(AbortSignal.timeout(5_000));
    rmSync(frmHome, { recursive: true, force: true });
    expect(left.stdout.trim()).toBe("");
  });

  describeExecutorContract(
    `container on ${HOST}`,
    () => {
      const slots = new SlotCounter(2);
      return {
        slots,
        executor: new ContainerExecutor({
          id: ID,
          slots,
          frmHome,
          config: config(),
          transport,
        }),
        programs: {
          cat: sh("process.stdin.pipe(process.stdout)"),
          interleave: sh(
            'const rl = require("node:readline").createInterface({ input: process.stdin }); const acks = rl[Symbol.asyncIterator](); (async () => { for (const [line, out] of [[1, process.stdout], [2, process.stderr], [3, process.stdout], [4, process.stderr]]) { out.write(line + "\\n"); await acks.next(); } rl.close(); process.stdin.destroy(); })();',
          ),
          whereami: sh(
            'process.stdout.write([process.cwd(), process.env.FOO, process.env.HOME ?? "-", ""].join("\\n"))',
          ),
          exit3: sh("process.exit(3)"),
          forever,
          missing: ["/nonexistent/frm-no-such-program"],
          ptyEcho: sh("0"),
        },
      };
    },
    {
      workdir: async () => {
        const dir = `${ROOT}/run/contract`;
        await remote(`mkdir -p ${dir}`);
        return dir;
      },
      removeWorkdir: async (dir) => {
        await remote(`rm -rf ${dir}`);
      },
      sessionRoot: (_dir, id) => sessionRoot(id),
    },
  );

  describe("on the docker host", { timeout: 90_000 }, () => {
    test("a canary secret reaches only the program's environ", async () => {
      const canary = randomBytes(16).toString("hex");
      const t0 = Math.floor(Date.now() / 1000) - 1;
      const ex = executor();
      const prepared = await ex.prepare({
        sessionId: "ses-canary",
        root: sessionRoot("ses-canary"),
      });
      const proc = await ex.exec(forever, {
        cwd: prepared.root,
        env: { FRM_CANARY: canary },
      });
      const { container, token } = parseRef(proc.ref, ID);
      const c = container ?? "";
      const shim = `$(pgrep -f '^node .*exec-shim.mjs run ${token}')`;
      const nowhere = [
        `docker inspect ${c}`,
        `for e in $(docker inspect -f '{{range .ExecIDs}}{{.}} {{end}}' ${c}); do curl -s --unix-socket /var/run/docker.sock http://docker/exec/$e/json; done`,
        `docker logs ${c} 2>&1`,
        `grep -rlF --binary-files=text ${canary} ${ROOT}; echo "grep=$?"`,
        "ps -eo args",
        `tr '\\0' '\\n' < /proc/${shim}/environ`,
        `journalctl --since @${t0} --no-pager 2>&1 | tail -n 2000`,
      ];
      for (const command of nowhere) {
        const ran = await remote(command);
        expect(ran.stdout + ran.stderr, command).not.toContain(canary);
      }
      expect(
        (await remote(`grep -rlF ${canary} ${ROOT}; echo "grep=$?"`)).stdout,
      ).toContain("grep=1");
      // The positive control: the program itself has it.
      const leader = await remote(
        `tr '\\0' '\\n' < /proc/$(pgrep -P ${shim})/environ`,
      );
      expect(leader.stdout).toContain(`FRM_CANARY=${canary}`);
      expect(
        execFileSync("ps", ["-A", "-ww", "-o", "args"], { encoding: "utf8" }),
      ).not.toContain(canary);
      proc.kill("SIGKILL");
      expect(await within(proc.exited, "canary exit")).toEqual({
        code: null,
        signal: "SIGKILL",
      });
    });

    test("a crash leaves the canary nowhere: the whole journal, apport, core dumps", async () => {
      const canary = randomBytes(16).toString("hex");
      const t0 = Math.floor(Date.now() / 1000) - 1;
      const ex = executor();
      const prepared = await ex.prepare({
        sessionId: "ses-crash",
        root: sessionRoot("ses-crash"),
      });
      const proc = await ex.exec(sh('process.kill(process.pid, "SIGSEGV")'), {
        cwd: prepared.root,
        env: { FRM_CANARY: canary },
      });
      expect(await within(proc.exited, "crash")).toEqual({
        code: null,
        signal: "SIGSEGV",
      });
      await vi.waitFor(async () => {
        expect((await remote("pgrep -x apport; true")).stdout.trim()).toBe("");
      }, REMOTE_WAIT);
      const searched = await remote(
        [
          `journalctl --since @${t0} --no-pager 2>&1`,
          "cat /var/log/apport.log 2>&1",
          "command -v coredumpctl >/dev/null && coredumpctl list --no-pager 2>&1",
          `grep -rlsF --binary-files=text ${canary} /var/crash /var/lib/systemd/coredump /var/log/apport.log; echo "grep=$?"`,
          `find /var/crash -newermt @${t0} -type f 2>/dev/null | sed 's/^/new crash file: /'`,
          "true",
        ].join("; "),
      );
      console.info(
        `crash evidence (${HOST}):\n${searched.stdout.split("\n").slice(-15).join("\n")}`,
      );
      expect(searched.stdout + searched.stderr).not.toContain(canary);
      expect(searched.stdout).not.toContain("grep=0");
    });

    test("cleanup(hard) kills the remote group and sweeps what escaped it", async () => {
      const ex = executor();
      const prepared = await ex.prepare({
        sessionId: "ses-orphan",
        root: sessionRoot("ses-orphan"),
      });
      const proc = await ex.exec(escapees, { cwd: prepared.root, env: {} });
      const c = containerOf(proc.ref);
      await vi.waitFor(async () => {
        expect(await top(c)).toContain("sleep 301");
      }, REMOTE_WAIT);
      await ex.cleanup(proc.ref, "hard");
      expect(await within(proc.exited, "cleanup")).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      await vi.waitFor(async () => {
        const after = await top(c);
        expect(after).not.toMatch(/sleep 30[01]/);
        expect(after).toContain("sleep infinity");
      }, REMOTE_WAIT);
    });

    test("kill-before-adopt: a fresh executor's prepare leaves only init and the keepalive", async () => {
      const first = executor();
      const prepared = await first.prepare({
        sessionId: "ses-adopt",
        root: sessionRoot("ses-adopt"),
      });
      const proc = await first.exec(escapees, { cwd: prepared.root, env: {} });
      const c = containerOf(proc.ref);
      await vi.waitFor(async () => {
        expect(await top(c)).toContain("sleep 301");
      }, REMOTE_WAIT);
      proc.kill("SIGKILL");
      expect(await within(proc.exited, "kill")).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      await vi.waitFor(async () => {
        const after = await top(c);
        expect(after).not.toContain("sleep 300"); // its group died with it
        expect(after).toContain("sleep 301"); // the setsid escapee did not
      }, REMOTE_WAIT);
      await executor().prepare({
        sessionId: "ses-adopt",
        root: sessionRoot("ses-adopt"),
      });
      const swept = await top(c);
      expect(swept).not.toMatch(/sleep 30[01]/);
      expect(swept).toContain("sleep infinity");
    });

    test("a dropped connection: exited settles SIGKILL, the group dies, probe says dead", async () => {
      const seen: ExecutorDiagnostic[] = [];
      const ex = executor({}, (d) => seen.push(d));
      const prepared = await ex.prepare({
        sessionId: "ses-drop",
        root: sessionRoot("ses-drop"),
      });
      const proc = await ex.exec(forever, { cwd: prepared.root, env: {} });
      const masters = execFileSync(
        "pgrep",
        ["-f", `ControlPath=${transport.target.controlPath} .* -M -N`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n");
      for (const pid of masters) process.kill(Number(pid), "SIGKILL");
      expect(await settles(proc.exited, 40_000)).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      expect(seen.map((d) => d.kind)).toContain("lost");
      await vi.waitFor(async () => {
        expect(await ex.probe(proc.ref)).toBe("dead");
      }, REMOTE_WAIT);
    });

    test("an OOM kill is reported by a shim that survives it", async () => {
      const seen: ExecutorDiagnostic[] = [];
      const ex = executor({ limits: { memory: "128m" } }, (d) => seen.push(d));
      const prepared = await ex.prepare({
        sessionId: "ses-oom",
        root: sessionRoot("ses-oom"),
      });
      const proc = await ex.exec(
        sh("const a = []; for (;;) a.push(Buffer.alloc(16777216, 1))"),
        { cwd: prepared.root, env: {} },
      );
      expect(await settles(proc.exited, 30_000)).toEqual({
        code: null,
        signal: "SIGKILL",
      });
      expect(seen.map((d) => d.kind)).toContain("oom");
    });

    test("every method answers within its own deadline when the host is unreachable", async () => {
      const home = mkdtempSync(join(tmpdir(), "frm-live-dead-"));
      const dead = new ContainerExecutor({
        id: ID,
        slots: new SlotCounter(2),
        frmHome: home,
        config: config({
          ssh: {
            host: "10.255.255.1",
            user: USER,
            identity_ref: `file:${KEY}`,
            known_hosts: knownHosts,
          },
          timeouts: {
            prepare_ms: 3_000,
            exec_ms: 2_000,
            probe_ms: 2_000,
            cleanup_ms: 2_000,
            close_ms: 1_000,
          },
        }),
      });
      const ref = `ctr:${ID}:host:0123456789abcdef`;
      const calls: [string, () => Promise<unknown>, number][] = [
        [
          "prepare",
          () =>
            dead.prepare({ sessionId: "ses-x", root: sessionRoot("ses-x") }),
          3_000,
        ],
        [
          "exec",
          () => dead.exec(forever, { cwd: `${ROOT}/run`, env: {} }),
          2_000,
        ],
        ["probe", () => dead.probe(ref), 2_000],
        ["cleanup", () => dead.cleanup(ref, "hard"), 2_000],
      ];
      for (const [what, call, bound] of calls) {
        const began = Date.now();
        await expect(call(), what).rejects.toMatchObject({ class: "timeout" });
        expect(Date.now() - began, what).toBeLessThan(bound + 1_000);
      }
      const began = Date.now();
      await dead.close();
      expect(Date.now() - began).toBeLessThan(2_000);
      rmSync(home, { recursive: true, force: true });
    });

    test("records the round-trip time (health and certification evidence)", () => {
      const rtt = transport.rttMs();
      console.info(`container executor ${ID}: rtt ${rtt} ms to ${HOST}`);
      expect(rtt).toEqual(expect.any(Number));
    });
  });
});

test.skipIf(LIVE)("the live container tests need FRM_CONTAINER=1", () => {
  expect(LIVE).toBe(false);
});
