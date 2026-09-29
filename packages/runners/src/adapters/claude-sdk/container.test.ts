// The CLI in a container executor's image: the lines the adapter hands the runner-neutral
// image, pinned to the CLI the installed SDK bundles by its manifest's own checksums; the check
// line run here against a stand-in `npm root -g` tree; and the defaults that say why no image can
// hold the CLI when the manifest cannot pin one.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { containerReadiness } from "@bayon/core";
import { afterAll, describe, expect, test, vi } from "vitest";
import {
  CLAUDE_IMAGE_CLI,
  EGRESS_HOSTS,
  LINUX_PLATFORMS,
  claudeContainerDefaults,
  cliPin,
  installLines,
  type CliPin,
} from "./container.js";
import { DEFAULTS, registration } from "./registration.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MANIFEST = JSON.parse(
  readFileSync(
    join(
      dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE)),
      "manifest.json",
    ),
    "utf8",
  ),
) as {
  readonly version: string;
  readonly platforms: Readonly<Record<string, { readonly checksum: string }>>;
};
/** image.ts's rule for one containerInstall line: no line break, no continuation. */
const ONE_LINE = /^[^\r\n\\]+$/;
/** BuildKit's limit for one Dockerfile line. */
const LINE_LIMIT = 64 * 1024;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-sdk-image-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the install lines", () => {
  test("pin the CLI the installed SDK bundles: its exact version, and its Linux binaries' checksums only", () => {
    const pin = cliPin(MANIFEST);
    if ("why" in pin) throw new Error(pin.why);
    const lines = installLines(pin);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `npm install -g @anthropic-ai/claude-code@${MANIFEST.version}`,
    );
    const check = lines[1] ?? "";
    expect(check).toContain(CLAUDE_IMAGE_CLI);
    const linux = LINUX_PLATFORMS.flatMap((p) => {
      const c = MANIFEST.platforms[p]?.checksum;
      return c === undefined ? [] : [c];
    });
    expect(linux.length).toBeGreaterThan(0);
    expect(pin).toEqual({ version: MANIFEST.version, checksums: linux });
    for (const c of linux) expect(check).toContain(c);
    for (const [name, p] of Object.entries(MANIFEST.platforms)) {
      if (!name.startsWith("linux-")) expect(check).not.toContain(p.checksum);
    }
    for (const line of lines) {
      expect(line).toMatch(ONE_LINE);
      expect(Buffer.byteLength(line)).toBeLessThan(LINE_LIMIT);
    }
  });

  test("the runner's defaults carry them, the gateway's allowlist, and no unready reason", () => {
    const pin = cliPin(MANIFEST);
    if ("why" in pin) throw new Error(pin.why);
    const defaults = registration().runner.defaults;
    expect(defaults).toEqual({
      ...DEFAULTS,
      containerInstall: installLines(pin),
      egressHosts: EGRESS_HOSTS,
    });
    expect(defaults).not.toHaveProperty("containerUnready");
    expect(containerReadiness(defaults)).toEqual({ ready: true });
  });

  test("hold no value from this process's env: a credential set here never reaches the image", () => {
    const sentinel = `sentinel-${randomBytes(12).toString("hex")}`;
    for (const name of DEFAULTS.secretEnvAnyOf.flat()) {
      vi.stubEnv(name, sentinel);
      vi.stubEnv(`FRM_SECRET_${name}`, sentinel);
    }
    try {
      const defaults = JSON.stringify(registration().runner.defaults);
      expect(defaults.includes(sentinel)).toBe(false);
      expect(defaults).not.toMatch(/build-arg|\bARG\b|LABEL/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("refuse a target, a version or a checksum that is not one plain shell word", () => {
    const pin: CliPin = { version: "2.1.269", checksums: ["a".repeat(64)] };
    for (const target of [
      "/opt/x y",
      "opt/claude",
      "/opt/../claude",
      "/opt/$(id)",
    ]) {
      expect(() => installLines(pin, target)).toThrow(
        expect.objectContaining({ class: "validation" }),
      );
    }
    for (const bad of [
      { ...pin, version: "2.1.269; reboot" },
      { ...pin, checksums: [] },
      { ...pin, checksums: ["abc"] },
      { ...pin, checksums: [`${"a".repeat(64)}|*`] },
    ]) {
      expect(() => installLines(bad)).toThrow(
        expect.objectContaining({ class: "validation" }),
      );
    }
  });
});

// Real processes (/bin/sh, sha256sum): a deadline for a loaded host, never a sleep.
describe(
  "the check line, run by /bin/sh against a stand-in npm tree",
  {
    timeout: 30_000,
  },
  () => {
    let n = 0;
    /** A global npm root holding `bytes` as the package's claude.exe (none: postinstall never ran). */
    function tree(bytes: Uint8Array | undefined): {
      readonly path: string;
      readonly target: string;
    } {
      const dir = join(root, `t${++n}`);
      const bin = join(dir, "bin");
      const pkg = join(dir, "global", "@anthropic-ai", "claude-code", "bin");
      mkdirSync(bin, { recursive: true });
      mkdirSync(pkg, { recursive: true });
      if (bytes !== undefined) writeFileSync(join(pkg, "claude.exe"), bytes);
      const npm = join(bin, "npm");
      writeFileSync(
        npm,
        `#!/bin/sh\n[ "$1 $2" = "root -g" ] && echo ${join(dir, "global")}\n`,
      );
      chmodSync(npm, 0o755);
      return {
        path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        target: join(dir, "opt", "frm", "runners", "claude-sdk", "claude"),
      };
    }
    const run = (line: string, path: string) =>
      spawnSync("/bin/sh", ["-c", line], {
        env: { PATH: path },
        encoding: "utf8",
      });

    const binary = randomBytes(4096);
    const pin: CliPin = {
      version: "2.1.269",
      checksums: [sha256(randomBytes(32)), sha256(binary)],
    };

    test("links the package's binary at the target and passes when its sha256 is pinned", () => {
      const t = tree(binary);
      const ran = run(installLines(pin, t.target)[1] ?? "", t.path);
      expect(ran.stderr).toBe("");
      expect(ran.status).toBe(0);
      expect(ran.stdout.trim()).toBe(
        `claude CLI 2.1.269: sha256 ${sha256(binary)}`,
      );
      expect(readlinkSync(t.target)).toMatch(
        /\/global\/@anthropic-ai\/claude-code\/bin\/claude\.exe$/,
      );
      expect(readFileSync(t.target)).toEqual(binary);
    });

    test("fails the build for any other binary, the stub postinstall leaves behind, or none", () => {
      for (const bytes of [
        randomBytes(4096),
        Buffer.alloc(500, 0x23),
        undefined,
      ]) {
        const t = tree(bytes);
        const ran = run(installLines(pin, t.target)[1] ?? "", t.path);
        expect(ran.status).not.toBe(0);
        expect(ran.stdout).toBe("");
      }
    });
  },
);

describe("a manifest that cannot pin a CLI", () => {
  const linux = { checksum: "b".repeat(64) };
  test.each([
    [undefined, "missing or has no platforms"],
    [{ version: "2.1.269" }, "missing or has no platforms"],
    [{ version: "2.1", platforms: { "linux-x64": linux } }, "not x.y.z"],
    [
      { version: "2.1.269", platforms: { "linux-x64": { checksum: "abc" } } },
      "no sha256 checksum for linux-x64",
    ],
    [
      { version: "2.1.269", platforms: { "darwin-arm64": linux } },
      "names no Linux CLI binary",
    ],
  ])("%j leaves no install line and says why", (manifest, why) => {
    const defaults = claudeContainerDefaults(manifest);
    expect(defaults).not.toHaveProperty("containerInstall");
    expect(defaults.egressHosts).toEqual(EGRESS_HOSTS);
    const readiness = containerReadiness(defaults);
    expect(readiness).toEqual({
      ready: false,
      reason: expect.stringContaining(why),
    });
  });
});
