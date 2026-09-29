import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { registrations } from "@bayon/runners";
import { afterEach, expect, test } from "vitest";
import {
  PLACEHOLDER_SECRET,
  schemaStandIn,
  secretNames,
  shimScript,
  standInEnv,
} from "./m3-stand-in.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

test("secretNames: every secretEnv, then the first of each any-of group, once each", () => {
  expect(
    secretNames({
      secretEnv: ["A"],
      secretEnvAnyOf: [["B", "C"], ["D"], ["A"]],
      other: 1,
    }),
  ).toEqual({ ok: true, value: ["A", "B", "D"] });
  expect(secretNames({})).toEqual({ ok: true, value: [] });
  expect(secretNames({ secretEnvAnyOf: [[]] })).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("shimScript quotes every word for sh and passes every argument on", () => {
  expect(shimScript(["/a b/node", "it's.mjs"])).toBe(
    `#!/bin/sh\nexec '/a b/node' 'it'\\''s.mjs' "$@"\n`,
  );
});

test("the schema stand-in: found by its caps, its shim first on PATH answers the pinned version", () => {
  const s = schemaStandIn();
  if (!s.ok) throw new Error(s.error.message);
  const reg = registrations().find((r) => r.runner.id === s.value.runnerId);
  expect(reg).toBeDefined();
  const home = mkdtempSync(join(tmpdir(), "frm-standin-"));
  homes.push(home);
  const env = standInEnv(home, s.value, "/usr/bin:/bin");
  if (!env.ok) throw new Error(env.error.message);
  const bin = join(home, "stand-in", "bin");
  expect(env.value["PATH"]).toBe(`${bin}${delimiter}/usr/bin:/bin`);
  expect(statSync(join(bin, s.value.cli.program)).mode & 0o111).not.toBe(0);
  for (const name of s.value.secrets)
    expect(env.value[`FRM_SECRET_${name}`]).toBe(PLACEHOLDER_SECRET);
  // As the supervisor's adapter runs it: by name, found on PATH.
  const version = execFileSync(s.value.cli.program, ["--version"], {
    encoding: "utf8",
    env: { PATH: env.value["PATH"] },
  });
  expect(version.split("\n")[0]).toBe(reg?.runner.versionDetected);
});
