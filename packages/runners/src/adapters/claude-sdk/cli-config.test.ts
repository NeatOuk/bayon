// The merge is pure and additive, so most of this is table-driven; the seam test uses
// the real local executor and a real home, because the 0600 mode and the file's location are the
// half that a pure test cannot prove.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter, type Executor } from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import type { SpawnSpec } from "../../adapter.js";
import { DEFAULTS } from "./registration.js";
import {
  CLI_CONFIG_FILE,
  UNREADABLE_SUFFIX,
  mergeCliConfig,
  seedCliConfig,
  type CliConfigPlan,
} from "./cli-config.js";

const root = mkdtempSync(join(tmpdir(), "frm-cli-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const local = new LocalExecutor({ id: "local", slots: new SlotCounter(4) });
const CWD = "/work/an earlier change";

/** The merged config a plan would write, or undefined when it writes nothing. */
const written = (plan: CliConfigPlan) =>
  plan.action === "keep" ? undefined : JSON.parse(plan.content);

describe("mergeCliConfig — the CLI owns this file; we only add to it", () => {
  test("no file yet: both gates seeded, the trust entry keyed by the session's cwd", () => {
    expect(written(mergeCliConfig(undefined, CWD))).toEqual({
      hasCompletedOnboarding: true,
      projects: { [CWD]: { hasTrustDialogAccepted: true } },
    });
  });

  test("an existing config keeps every key the CLI wrote, including other projects", () => {
    const existing = JSON.stringify({
      userID: "u1",
      machineID: "m1",
      migrationVersion: 14,
      seenNotifications: { tips: ["a"] },
      projects: {
        "/other": { hasTrustDialogAccepted: true, allowedTools: ["Read"] },
      },
    });
    expect(written(mergeCliConfig(existing, CWD))).toEqual({
      userID: "u1",
      machineID: "m1",
      migrationVersion: 14,
      seenNotifications: { tips: ["a"] },
      hasCompletedOnboarding: true,
      projects: {
        "/other": { hasTrustDialogAccepted: true, allowedTools: ["Read"] },
        [CWD]: { hasTrustDialogAccepted: true },
      },
    });
  });

  test("an existing project entry keeps its own keys", () => {
    const existing = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [CWD]: { allowedTools: ["Bash"] } },
    });
    expect(written(mergeCliConfig(existing, CWD))?.projects[CWD]).toEqual({
      allowedTools: ["Bash"],
      hasTrustDialogAccepted: true,
    });
  });

  test("already seeded: nothing to write", () => {
    const seeded = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [CWD]: { hasTrustDialogAccepted: true } },
    });
    expect(mergeCliConfig(seeded, CWD)).toEqual({ action: "keep" });
  });

  test("onboarded but this workspace untrusted: still written (the trust gate is per-cwd)", () => {
    const other = JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { "/elsewhere": { hasTrustDialogAccepted: true } },
    });
    expect(mergeCliConfig(other, CWD).action).toBe("write");
  });

  test("trusted but not onboarded: still written", () => {
    const half = JSON.stringify({
      projects: { [CWD]: { hasTrustDialogAccepted: true } },
    });
    expect(written(mergeCliConfig(half, CWD))?.hasCompletedOnboarding).toBe(
      true,
    );
  });

  test("a file we do not understand is replaced, not merged into and not silently skipped", () => {
    for (const raw of ["{not json", "[]", '"a string"', "null", "42"]) {
      const plan = mergeCliConfig(raw, CWD);
      // "replace" rather than "write": seedCliConfig keeps the old bytes beside the new file, so a
      // config we could not read leaves evidence instead of vanishing.
      expect(plan.action).toBe("replace");
      expect(written(plan)).toEqual({
        hasCompletedOnboarding: true,
        projects: { [CWD]: { hasTrustDialogAccepted: true } },
      });
    }
  });

  test("a non-object projects value is not trusted as one", () => {
    // The CLI would never write this; if it did, replacing it is better than reading through it.
    expect(
      written(mergeCliConfig('{"projects":"nope"}', CWD))?.projects,
    ).toEqual({
      [CWD]: { hasTrustDialogAccepted: true },
    });
  });
});

function spec(n: string): SpawnSpec {
  const base = join(root, n);
  const homeDir = join(base, "home");
  mkdirSync(homeDir, { recursive: true });
  return {
    sessionId: `01SEED${n}`,
    cwd: join(base, "work"),
    homeDir,
    env: {},
    model: "claude-haiku-4-5",
    flags: { ...DEFAULTS },
  };
}

describe("seedCliConfig", () => {
  test("writes the config into the home at 0600, and is idempotent", async () => {
    const s = spec("a");
    const path = join(s.homeDir, CLI_CONFIG_FILE);

    expect(await seedCliConfig(s, local)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      projects: { [s.cwd]: { hasTrustDialogAccepted: true } },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const first = readFileSync(path, "utf8");
    expect(await seedCliConfig(s, local)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  test("state the CLI wrote after the first attach survives the next one", async () => {
    const s = spec("b");
    const path = join(s.homeDir, CLI_CONFIG_FILE);
    await seedCliConfig(s, local);
    // What the real CLI does on its first interactive start.
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      path,
      JSON.stringify({ ...written, userID: "u", machineID: "m" }),
    );

    await seedCliConfig(s, local);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      userID: "u",
      machineID: "m",
      hasCompletedOnboarding: true,
    });
  });

  test("an unparseable config is set aside byte for byte and replaced, so the attach works and the evidence survives", async () => {
    const s = spec("c");
    const path = join(s.homeDir, CLI_CONFIG_FILE);
    writeFileSync(path, "{ truncated", { mode: 0o600 });

    expect(await seedCliConfig(s, local)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hasCompletedOnboarding: true,
      projects: { [s.cwd]: { hasTrustDialogAccepted: true } },
    });
    expect(readFileSync(`${path}${UNREADABLE_SUFFIX}`, "utf8")).toBe(
      "{ truncated",
    );
  });

  test("an unreadable config fails loudly rather than being written over", async () => {
    const s = spec("d");
    // A directory where the file should be: readFileSync gives EISDIR, not ENOENT.
    mkdirSync(join(s.homeDir, CLI_CONFIG_FILE));

    const result = await seedCliConfig(s, local);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.class).toBe("spawn_failed");
  });

  test("a home that is not this host's is left untouched", async () => {
    const s = spec("e");
    // A container to the adapter, running on this host — the same stand-in shape home-file.test.ts
    // uses. Seeding needs to read first, and the read half has no remote form, so it must not write.
    const remote: Executor = {
      id: "ctr-stand-in",
      kind: "container",
      capabilities: { pty: false },
      envPath: process.env["PATH"] ?? "/usr/bin:/bin",
      prepare: (p) => local.prepare(p),
      exec: (a, opts) => local.exec(a, opts),
      pty: (a, opts) => local.pty(a, opts),
      probe: (ref) => local.probe(ref),
      cleanup: (ref, mode) => local.cleanup(ref, mode),
      capacity: () => local.capacity(),
      health: (limits) => local.health(limits),
    };
    expect(await seedCliConfig(s, remote)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(() => readFileSync(join(s.homeDir, CLI_CONFIG_FILE))).toThrow();
  });
});
