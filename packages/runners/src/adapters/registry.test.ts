import { execFileSync } from "node:child_process";
import { RunnerCaps, containerReadiness } from "@bayon/core";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  RUNNER_IDS,
  STUB_RUNNER_IDS,
  loadAdapter,
  registrations,
  stubCli,
} from "./registry.js";

test("stubCli: each stand-in CLI answers --version with the pinned line, under the name its adapter runs", () => {
  const withCli = RUNNER_IDS.filter((id) => stubCli(id).ok);
  expect(withCli.length).toBeGreaterThan(0);
  for (const id of withCli) {
    expect(STUB_RUNNER_IDS).toContain(id);
    const cli = stubCli(id);
    if (!cli.ok) throw new Error(cli.error.message);
    const runner = registrations().find((r) => r.runner.id === id)?.runner;
    const bin = z
      .object({ bin: z.array(z.string()) })
      .parse(runner?.defaults).bin;
    expect(bin[0]).toBe(cli.value.program);
    const [program, ...args] = cli.value.argv;
    const version = execFileSync(program, [...args, "--version"], {
      encoding: "utf8",
    });
    expect(version.split("\n")[0]).toBe(runner?.versionDetected);
  }
  for (const id of ["fixture", "toString", ""])
    expect(stubCli(id)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
});

test("every registered id loads an adapter with that id", () => {
  expect(RUNNER_IDS).toEqual([
    "claude-sdk",
    "codex-exec",
    "fixture",
    "opencode",
  ]);
  for (const id of RUNNER_IDS) {
    const adapter = loadAdapter(id);
    expect(adapter.ok && adapter.value.id).toBe(id);
  }
});

test("an unknown id, prototype keys included, is not_found", () => {
  for (const id of ["codex-appserver", "toString", "__proto__", ""]) {
    expect(loadAdapter(id)).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  }
});

test("container readiness as each adapter declares it: every runner ready but opencode, claude-sdk since an earlier change", () => {
  const readiness = Object.fromEntries(
    registrations().map((r) => [
      r.runner.id,
      containerReadiness(r.runner.defaults),
    ]),
  );
  expect(readiness).toEqual({
    "claude-sdk": { ready: true },
    "codex-exec": { ready: true },
    fixture: { ready: true },
    opencode: {
      ready: false,
      reason: expect.stringContaining("no image installs opencode yet"),
    },
  });
});

test("registrations never collide: runner ids and model ids are unique, caps are valid, one active row per tier", () => {
  const regs = registrations();
  const runnerIds = regs.map((r) => r.runner.id);
  const modelIds = regs.flatMap((r) => r.models.map((m) => m.id));
  expect(new Set(runnerIds).size).toBe(runnerIds.length);
  expect(new Set(modelIds).size).toBe(modelIds.length);
  for (const r of regs) {
    expect(RunnerCaps.safeParse(r.runner.caps).success).toBe(true);
    expect(r.models.every((m) => m.id.startsWith(`${r.runner.id}.`))).toBe(
      true,
    );
    // One active row per tier; a standby row is registered but inactive.
    expect(
      r.models
        .filter((m) => m.standby !== true)
        .map((m) => m.tier)
        .toSorted(),
    ).toEqual(["cheap", "complex", "standard"]);
  }
});
