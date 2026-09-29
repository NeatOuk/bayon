import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  FakeClock,
  SUITE_VERSION,
  SUPERVISOR_LOCK_FILE,
  certify,
  type RunnerCaps,
} from "@bayon/core";
import {
  getExecutor,
  getSettings,
  listAuditPage,
  openDb,
  type Db,
  type RunnerCertificationRow,
} from "@bayon/db";
import { migrateUp, seedConfig } from "@bayon/db/operator";
import { registrations } from "@bayon/runners";
import { afterAll, describe, expect, test } from "vitest";
import { parseCli } from "./cli.js";
import {
  lapsingOf,
  parseExecutorCli,
  runExecutorCommand,
  runnerContainerDefaults,
  supervisorNote,
  type ExecutorCommand,
} from "./executor.js";

/** Caps that make every §15 test a pass, so a fixture row certifies and pins what it is given. */
const CERT_CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: true,
  sandboxModes: false,
  mcpClient: true,
  hooks: false,
  pty: false,
  outputSchema: true,
  imageInput: false,
  subagents: false,
};

const dir = mkdtempSync(join(tmpdir(), "frm-executor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HOST = "192.0.2.10";
const ADD = [
  "add",
  "ctr-lab",
  "--host",
  HOST,
  "--user",
  "ops",
  "--identity-ref",
  "file:/keys/id_ed25519",
  "--remote-root",
  "/home/ops/frm",
];
const failure = (argv: string[]) => {
  const parsed = parseExecutorCli(argv);
  return parsed.ok ? "parsed" : parsed.error.message;
};

/** A live `runner_certifications` row for ctr-lab whose stored result pins `imageId`. */
function certificationRow(
  runnerId: string,
  imageId: string | null,
): RunnerCertificationRow {
  const certified = certify({
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: runnerId,
    runner_version: "1",
    executor: { id: "ctr-lab", kind: "container", image_id: imageId },
    started_at: 1_000,
    finished_at: 2_000,
    kit_hash: "sha256:abc",
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
    caps: CERT_CAPS,
    spend: { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
    tests: CONFORMANCE_TEST_IDS.map((id) => ({
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: "pass" as const,
      attempts: 1,
      duration_ms: 1,
      fallback: null,
      checks: [{ name: "held", ok: true, detail: null }],
    })),
  });
  if (!certified.ok) throw new Error(certified.error.message);
  return {
    runner_id: runnerId,
    executor_id: "ctr-lab",
    model_id: `${runnerId}.cheap`,
    compression: 0,
    model: "m",
    runner_version: "1",
    suite_version: SUITE_VERSION,
    kit_hash: "sha256:abc",
    caps_hash: "sha256:def",
    result_json: JSON.stringify(certified.value),
    report_path: null,
    gate_eligible: 1,
    passed_at: 2_000,
    certified_at: 2_000,
    decertified_at: null,
    decertified_reason: null,
  };
}

// A real key line, so ssh-keygen -F reads the file as it would the operator's.
execFileSync("ssh-keygen", [
  "-q",
  "-t",
  "ed25519",
  "-N",
  "",
  "-f",
  join(dir, "k"),
]);
const pub = readFileSync(join(dir, "k.pub"), "utf8")
  .split(" ")
  .slice(0, 2)
  .join(" ");
const operatorKnownHosts = join(dir, "known_hosts");
writeFileSync(
  operatorKnownHosts,
  [
    `other.example.com ${pub}`,
    `${HOST} ${pub}`,
    `[${HOST}]:2222 ${pub}`,
    "",
  ].join("\n"),
);

describe("parseExecutorCli", () => {
  test("add: the ctr-lab row's defaults — frm-internal, 2 slots, the base as its image until built", () => {
    const parsed = parseExecutorCli(ADD);
    expect(parsed).toEqual({
      ok: true,
      value: {
        action: "add",
        id: "ctr-lab",
        config: {
          remote_root: "/home/ops/frm",
          image: "node:22-trixie-slim",
          network: "frm-internal",
          egress_allow: [],
        },
        ssh: {
          host: HOST,
          user: "ops",
          identity_ref: "file:/keys/id_ed25519",
        },
        target: { host: HOST, port: 22 },
        slots: 2,
        knownHostsFrom: expect.stringMatching(/\.ssh\/known_hosts$/),
      },
    });
  });

  test("add: every optional flag reaches the config", () => {
    const parsed = parseExecutorCli([
      ...ADD,
      "--port",
      "2222",
      "--slots",
      "3",
      "--network",
      "frm-int2",
      "--egress-allow",
      "registry.npmjs.org,pypi.org",
      "--base-image",
      "node:22-bookworm",
      "--min-free-pct",
      "10",
      "--quota-gb",
      "15",
      "--known-hosts",
      "/k/known_hosts",
    ]);
    expect(parsed.ok && parsed.value).toMatchObject({
      config: {
        image: "node:22-bookworm",
        base_image: "node:22-bookworm",
        network: "frm-int2",
        egress_allow: ["registry.npmjs.org", "pypi.org"],
        min_free_pct: 10,
        quota_gb: 15,
      },
      ssh: { port: 2222 },
      target: { host: HOST, port: 2222 },
      slots: 3,
      knownHostsFrom: "/k/known_hosts",
    });
  });

  test("add: --untrusted-roles is a union, --replace-untrusted-roles the whole list; neither, nothing", () => {
    const union = parseExecutorCli([
      ...ADD,
      "--untrusted-roles",
      "investigator,reviewer,investigator",
    ]);
    expect(union.ok && union.value).toMatchObject({
      untrustedRoles: { roles: ["investigator", "reviewer"], mode: "union" },
    });
    const replace = parseExecutorCli([
      ...ADD,
      "--replace-untrusted-roles",
      "investigator",
    ]);
    expect(replace.ok && replace.value).toMatchObject({
      untrustedRoles: { roles: ["investigator"], mode: "replace" },
    });
    const plain = parseExecutorCli(ADD);
    expect(plain.ok && "untrustedRoles" in plain.value).toBe(false);
  });

  test("image takes the id alone", () => {
    expect(parseExecutorCli(["image", "ctr-lab"])).toEqual({
      ok: true,
      value: { action: "image", id: "ctr-lab" },
    });
    expect(parseCli(["executor", "image", "ctr-lab"])).toEqual({
      ok: true,
      value: {
        command: "executor",
        options: { action: "image", id: "ctr-lab" },
      },
    });
  });

  // disable and enable take an id and nothing else.
  test.each([["disable"], ["enable"]])("%s <id> parses", (action) => {
    expect(parseExecutorCli([action, "ctr-lab"])).toEqual({
      ok: true,
      value: { action, id: "ctr-lab" },
    });
  });

  test.each([
    [["image", "ctr-lab", "--host", "h"], "frm executor image takes no flags"],
    [
      ["disable", "ctr-lab", "--slots", "1"],
      "frm executor disable takes no flags",
    ],
    [["enable", "ctr-lab", "extra"], "usage"],
    [["disable"], "usage"],
    [["enable", "CTR_172"], "must match"],
    [["add"], "usage"],
    [["rm", "ctr-lab"], "usage"],
    [["image", "ctr-lab", "extra"], "usage"],
    [["image", "CTR_172"], "must match"],
    [["add", "ctr-lab", "--host", HOST], "ssh.user"],
    [[...ADD, "--identity-ref", "/keys/raw-key"], "ssh.identity_ref"],
    [[...ADD, "--egress-allow", "Example.com"], "egress_allow"],
    [[...ADD, "--port", "ssh"], "ssh.port"],
    [[...ADD, "--slots", "0"], "--slots"],
    [[...ADD, "--remote-root", "/home/ops/../etc"], "remote_root"],
    [[...ADD, "--bogus"], "Unknown option"],
    // Roles are checked against the real set (proto WORK_ROLES), never only their shape.
    [
      [...ADD, "--untrusted-roles", "investigatr"],
      '--untrusted-roles: "investigatr" is not a role (orchestrator, builder, reviewer, investigator)',
    ],
    [
      [...ADD, "--replace-untrusted-roles", "reviewer,qa"],
      '--replace-untrusted-roles: "qa" is not a role',
    ],
    [
      [
        ...ADD,
        "--untrusted-roles",
        "reviewer",
        "--replace-untrusted-roles",
        "reviewer",
      ],
      "give one",
    ],
  ])("%j is refused (%s)", (argv, reason) => {
    expect(failure(argv)).toContain(reason);
  });
});

// pinKnownHosts's own unit tests moved to packages/executors/src/container/host-key.test.ts
//: it is shared with `POST /executors` now, not owned by this CLI file.

function unwrapOk<T>(
  r: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("runnerContainerDefaults", () => {
  const reg = (id: string, defaults: Record<string, unknown>) => ({
    models: [],
    runner: {
      id,
      kind: "script" as const,
      adapter: id,
      versionDetected: "1",
      caps: {} as never,
      defaults,
    },
  });

  test("install lines in runner-id order; egress hosts merged, sorted, deduplicated", () => {
    expect(
      runnerContainerDefaults([
        reg("zeta", {
          containerInstall: ["npm i -g z@1"],
          egressHosts: ["api.z.example"],
        }),
        reg("alpha", {
          containerInstall: ["npm i -g a@1", "npm i -g a2@1"],
          egressHosts: ["api.z.example", "api.a.example"],
        }),
        reg("none", {}),
      ]),
    ).toEqual({
      ok: true,
      value: {
        installs: ["npm i -g a@1", "npm i -g a2@1", "npm i -g z@1"],
        egressHosts: ["api.a.example", "api.z.example"],
      },
    });
  });

  test("a runner's bad egress host is refused", () => {
    const r = runnerContainerDefaults([
      reg("x", { egressHosts: ["not a host"] }),
    ]);
    expect(r.ok ? "ok" : r.error.message).toContain("runner x");
  });

  test("the registered runners' defaults all parse", () => {
    const r = unwrapOk(runnerContainerDefaults(registrations()));
    expect(r.installs.every((line) => !line.includes("\n"))).toBe(true);
    expect(r.egressHosts.length).toBeGreaterThan(0);
  });
});

describe("runExecutorCommand", () => {
  const home = join(dir, "frm-home");
  const lines: string[] = [];
  const io = {
    env: { FRM_HOME: home },
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
  const add = (): ExecutorCommand => {
    const parsed = parseExecutorCli([
      ...ADD,
      "--known-hosts",
      operatorKnownHosts,
    ]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  };
  /** `add <id>` with its own remote root and the given trust flags. */
  const addWith = async (id: string, ...flags: string[]) => {
    const parsed = parseExecutorCli([
      "add",
      id,
      "--host",
      HOST,
      "--user",
      "ops",
      "--identity-ref",
      "file:/keys/id_ed25519",
      "--remote-root",
      `/home/ops/${id}`,
      "--known-hosts",
      operatorKnownHosts,
      ...flags,
    ]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    lines.length = 0;
    return runExecutorCommand(parsed.value, io);
  };
  const row = async () => {
    const db = unwrapOk(
      await openDb({ path: join(home, "foreman.db"), clock: new FakeClock(0) }),
    );
    try {
      return await getExecutor(db, "ctr-lab");
    } finally {
      await db.close();
    }
  };

  const untrustedRoles = async () => {
    const db = unwrapOk(
      await openDb({ path: join(home, "foreman.db"), clock: new FakeClock(0) }),
    );
    try {
      return unwrapOk(await getSettings(db, ["executors.untrusted_roles"])).get(
        "executors.untrusted_roles",
      );
    } finally {
      await db.close();
    }
  };

  test("add writes the ctr-lab row and pins its host key under FRM_HOME", async () => {
    expect(await runExecutorCommand(add(), io)).toBe(0);
    const pinned = join(home, "executors", "ctr-lab", "known_hosts");
    expect(readFileSync(pinned, "utf8")).toBe(`${HOST} ${pub}\n`);
    const r = unwrapOk(await row());
    expect(r).toMatchObject({
      kind: "container",
      trust: "untrusted",
      egress_policy: "allowlist",
      slots: 2,
      health: "unknown",
    });
    expect(JSON.parse(r.config_json)).toEqual({
      egress_allow: [],
      image: "node:22-trixie-slim",
      network: "frm-internal",
      remote_root: "/home/ops/frm",
      ssh: {
        host: HOST,
        identity_ref: "file:/keys/id_ed25519",
        known_hosts: pinned,
        user: "ops",
      },
    });
    // Trust is operator policy: without a flag, adding an executor leaves it alone, and says so.
    expect(await untrustedRoles()).toEqual(["investigator"]);
    expect(lines.join("\n")).toContain(
      "trust     executors.untrusted_roles: investigator (unchanged; --untrusted-roles adds to it)",
    );
  });

  test("a second add is a conflict, and the pinned key is left as it was", async () => {
    const pinned = join(home, "executors", "ctr-lab", "known_hosts");
    writeFileSync(pinned, "kept\n");
    lines.length = 0;
    expect(await runExecutorCommand(add(), io)).toBe(1);
    expect(lines.join("\n")).toContain("exists; its host key is not re-pinned");
    expect(readFileSync(pinned, "utf8")).toBe("kept\n");
  });

  test("--untrusted-roles is a union: a later add with a narrower list keeps reviewer", async () => {
    expect(
      await addWith("ctr-173", "--untrusted-roles", "investigator,reviewer"),
    ).toBe(0);
    expect(await untrustedRoles()).toEqual(["investigator", "reviewer"]);
    expect(lines.join("\n")).toContain(
      "trust     executors.untrusted_roles: investigator → investigator, reviewer",
    );
    expect(await addWith("ctr-174", "--untrusted-roles", "investigator")).toBe(
      0,
    );
    expect(await untrustedRoles()).toEqual(["investigator", "reviewer"]);
    expect(lines.join("\n")).toContain(
      "trust     executors.untrusted_roles: investigator, reviewer → investigator, reviewer",
    );
  });

  test("--replace-untrusted-roles sets the whole list, and says what it dropped", async () => {
    expect(
      await addWith("ctr-175", "--replace-untrusted-roles", "investigator"),
    ).toBe(0);
    expect(await untrustedRoles()).toEqual(["investigator"]);
    expect(lines.join("\n")).toContain(
      "trust     executors.untrusted_roles: investigator, reviewer → investigator",
    );
  });

  test("image refuses what is not a container executor, before any ssh", async () => {
    const db = unwrapOk(
      await openDb({ path: join(home, "foreman.db"), clock: new FakeClock(0) }),
    );
    unwrapOk(await migrateUp(db, {}));
    unwrapOk(
      await seedConfig(db, {
        executors: [{ id: "here", kind: "local", config_json: "{}" }],
      }),
    );
    await db.close();
    lines.length = 0;
    expect(await runExecutorCommand({ action: "image", id: "here" }, io)).toBe(
      1,
    );
    expect(lines.join("\n")).toContain(
      "executor here is local, not a container executor",
    );
    expect(await runExecutorCommand({ action: "image", id: "nope" }, io)).toBe(
      1,
    );
  });

  test("image says when a supervisor may be running on this FRM_HOME", async () => {
    const lock = join(home, SUPERVISOR_LOCK_FILE);
    expect(supervisorNote(home)).toBeNull();
    writeFileSync(lock, "");
    try {
      expect(supervisorNote(home)).toContain("may be running");
      lines.length = 0;
      // Said before anything else: the operator sees it even when the command then refuses.
      await runExecutorCommand({ action: "image", id: "nope" }, io);
      expect(lines[0]).toContain(
        "a supervisor may be running on this FRM_HOME",
      );
    } finally {
      rmSync(lock, { force: true });
    }
  });

  // A container pair that pins no image is not one that merely survives an image
  // change: it is one nothing can falsify, so it is not certified for unattended work at all and
  // the next boot decertifies it. Every container certification predating an earlier change has none — and
  // new base builds a wholly different image — so "none lapse on this image" was the
  // last thing an operator read before walking away from an uncertified pair.
  test("image names the pairs that lapse and the ones that pin no image at all", () => {
    const ID_A = `sha256:${"a".repeat(64)}`;
    const ID_B = `sha256:${"b".repeat(64)}`;
    const rows = [
      certificationRow("pinned-here", ID_A),
      certificationRow("pinned-elsewhere", ID_B),
      certificationRow("unpinned", null),
      { ...certificationRow("gone", ID_B), decertified_at: 7 },
      { ...certificationRow("other-executor", ID_B), executor_id: "ctr-9" },
    ];
    expect(lapsingOf(rows, "ctr-lab", ID_A)).toBe(
      "pinned-elsewhere lapses on the next health pass; unpinned pins no image, " +
        "so it is not certified for unattended work; re-run `frm runner conformance`",
    );
    expect(
      lapsingOf([certificationRow("pinned-here", ID_A)], "ctr-lab", ID_A),
    ).toBe("none lapse on this image");
    expect(lapsingOf([], "ctr-lab", ID_A)).toBe("none lapse on this image");
  });

  test("no FRM_HOME is a usage error", async () => {
    expect(await runExecutorCommand(add(), { ...io, env: {} })).toBe(2);
  });

  // the kill switch's handle. One column moves; the operator is told what did not.
  describe("disable and enable", () => {
    const withDb = async <T>(f: (db: Db) => Promise<T>): Promise<T> => {
      const db = unwrapOk(
        await openDb({
          path: join(home, "foreman.db"),
          clock: new FakeClock(0),
        }),
      );
      try {
        return await f(db);
      } finally {
        await db.close();
      }
    };
    const enabledOf = (id: string) =>
      withDb(async (db) => unwrapOk(await getExecutor(db, id)).enabled);
    const audits = () =>
      withDb(async (db) =>
        unwrapOk(await listAuditPage(db, { limit: 50 })).rows.map(
          (a) => a.action,
        ),
      );

    test("disable takes it out of service and enable puts it back, each audited", async () => {
      expect(await addWith("ctr-off")).toBe(0);
      expect(await enabledOf("ctr-off")).toBe(1);

      lines.length = 0;
      expect(
        await runExecutorCommand({ action: "disable", id: "ctr-off" }, io),
      ).toBe(0);
      expect(await enabledOf("ctr-off")).toBe(0);
      const disabled = lines.join("\n");
      expect(disabled).toContain("executor ctr-off: disabled");
      expect(disabled).toContain("admission refuses new sessions here");
      expect(disabled).toContain("certifications and probe history are kept");
      expect(disabled).toContain("sessions  0 live on it");
      expect(disabled).toContain("audited   executor.disable via frm");

      lines.length = 0;
      expect(
        await runExecutorCommand({ action: "enable", id: "ctr-off" }, io),
      ).toBe(0);
      expect(await enabledOf("ctr-off")).toBe(1);
      expect(lines.join("\n")).toContain("executor ctr-off: enabled");
      expect(await audits()).toEqual(
        expect.arrayContaining(["executor.disable", "executor.enable"]),
      );
    });

    test("the state it already has says so and writes no audit row", async () => {
      expect(await addWith("ctr-on")).toBe(0);
      const before = (await audits()).length;
      lines.length = 0;
      expect(
        await runExecutorCommand({ action: "enable", id: "ctr-on" }, io),
      ).toBe(0);
      expect(lines.join("\n")).toContain(
        "executor ctr-on: already enabled; nothing written",
      );
      expect(lines.join("\n")).not.toContain("audited");
      expect((await audits()).length).toBe(before);
    });

    test("an unknown executor fails, naming it", async () => {
      lines.length = 0;
      expect(
        await runExecutorCommand({ action: "disable", id: "nobody" }, io),
      ).toBe(1);
      expect(lines.join("\n")).toContain(
        "frm executor disable: executor nobody does not exist",
      );
    });
  });
});
