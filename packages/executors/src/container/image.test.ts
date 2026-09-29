import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DEFAULT_GIT_PATCHED } from "@bayon/core";
import {
  buildImage,
  buildMarker,
  GATEWAY_SCRIPT,
  renderImage,
  type ImageSpec,
} from "./image.js";
import { PlumbingScripts } from "./plumbing-scripts.js";
import { layoutOf } from "./route.js";
import type { Ran } from "./transport.js";

const BASE = `sha256:${"a".repeat(64)}`;
const SPEC: ImageSpec = {
  executorId: "ctr-lab",
  baseId: BASE,
  installs: ["npm install -g one@1.0.0", "npm install -g two@2.0.0"],
  shim: Buffer.from("// the exec-shim\n"),
  relay: Buffer.from("// the relay\n"),
};
const RUN = "RUN : frm.executor=ctr-lab &&";
const dir = mkdtempSync(join(tmpdir(), "frm-image-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("renderImage", () => {
  test("FROM the base by id, labels first, the packages, each install line, then the files", () => {
    const ctx = renderImage(SPEC);
    const lines = ctx.dockerfile.split("\n");
    expect(lines.slice(1, 3)).toEqual([
      `FROM ${BASE}`,
      "LABEL frm.managed=1 frm.executor=ctr-lab",
    ]);
    expect(lines[3]).toBe(
      `${RUN} apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates git tini tinyproxy && rm -rf /var/lib/apt/lists/*`,
    );
    expect(ctx.dockerfile).not.toContain("socat");
    expect(lines.slice(4)).toEqual([
      `${RUN} npm install -g one@1.0.0`,
      `${RUN} npm install -g two@2.0.0`,
      "COPY exec-shim.mjs gateway.sh mcp-relay.mjs /opt/frm/",
      "",
    ]);
    // Every step's command names the executor: the marker leftovers are found by.
    const steps = lines.filter((l) => /^(?:LABEL|RUN) /.test(l));
    expect(steps).toHaveLength(4);
    for (const step of steps) expect(step).toContain(buildMarker("ctr-lab"));
    expect(ctx.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.tag).toBe(`frm-ctr-lab:${ctx.hash.slice(0, 12)}`);
    writeFileSync(join(dir, "ctx.tar"), ctx.tar);
    expect(
      execFileSync("tar", ["-tvf", "ctx.tar"], { cwd: dir, encoding: "utf8" }),
    ).toMatch(/-rwxr-xr-x.*gateway\.sh/);
    expect(
      execFileSync("tar", ["-tf", "ctx.tar"], { cwd: dir, encoding: "utf8" })
        .trim()
        .split("\n"),
    ).toEqual(["Dockerfile", "exec-shim.mjs", "gateway.sh", "mcp-relay.mjs"]);
  });

  test("the marker is a no-op for the shell: an install line keeps its meaning", () => {
    for (const [line, expected] of [
      ["echo a || echo b", "a"],
      ["false || echo b", "b"],
      ["echo a; echo b", "a\nb"],
      ["X=1 sh -c 'echo $X'", "1"],
    ] as const) {
      expect(
        execFileSync("sh", ["-c", `: ${buildMarker("ctr-lab")} && ${line}`], {
          encoding: "utf8",
        }).trim(),
      ).toBe(expected);
    }
  });

  test("the tag is the context's hash: stable, and it moves with the base, an install or the shim", () => {
    const tag = renderImage(SPEC).tag;
    expect(renderImage(SPEC).tag).toBe(tag);
    for (const change of [
      { baseId: `sha256:${"b".repeat(64)}` },
      { installs: SPEC.installs.slice(1) },
      { shim: Buffer.from("// another shim\n") },
      { relay: Buffer.from("// another relay\n") },
      { executorId: "ctr-173" },
    ]) {
      expect(renderImage({ ...SPEC, ...change }).tag).not.toBe(tag);
    }
  });

  test("refuses a base that is not an id, a multi-line install, and an id docker cannot name", () => {
    expect(() =>
      renderImage({ ...SPEC, baseId: "node:22-bookworm-slim" }),
    ).toThrow(/image id/);
    expect(() =>
      renderImage({ ...SPEC, installs: ["apt-get install x\nRUN evil"] }),
    ).toThrow(/one shell line/);
    expect(() => renderImage({ ...SPEC, installs: ["a \\"] })).toThrow(
      /one shell line/,
    );
    expect(() => renderImage({ ...SPEC, executorId: "ctr-" })).toThrow(
      /docker repository/,
    );
  });
});

describe("the gateway script", () => {
  const bin = join(dir, "bin");
  const fake = (name: string, body: string) => {
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };

  test("is valid sh", () => {
    execFileSync("sh", ["-n", "-c", GATEWAY_SCRIPT]);
  });

  test("writes a default-deny allowlist of anchored, escaped hosts, and exits once a child dies", () => {
    fake("tinyproxy", `echo "$@" > "${dir}/tinyproxy.args"`);
    fake(
      "node",
      `echo "$@" > "${dir}/node.args"; echo "$FRM_MCP_PORT $FRM_MCP_PATH" > "${dir}/node.env"`,
    );
    const script = GATEWAY_SCRIPT.replaceAll("/tmp/", `${dir}/`).replace(
      "sleep 5",
      "sleep 0.05",
    );
    let code = 0;
    try {
      execFileSync("sh", ["-c", script], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          FRM_EGRESS_ALLOW: "api.example.com,registry.npmjs.org",
          FRM_MCP_PORT: "3010",
          FRM_MCP_PATH: "/mcp",
          FRM_PROXY_PORT: "8888",
        },
        timeout: 10_000,
      });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
    expect(readFileSync(join(dir, "filter"), "utf8")).toBe(
      "^api\\.example\\.com$\n^registry\\.npmjs\\.org$\n",
    );
    const conf = readFileSync(join(dir, "tinyproxy.conf"), "utf8");
    for (const line of [
      "Port 8888",
      "FilterDefaultDeny Yes",
      "FilterType ere",
      `Filter "${dir}/filter"`,
      "ConnectPort 443",
    ]) {
      expect(conf).toContain(line);
    }
    expect(readFileSync(join(dir, "tinyproxy.args"), "utf8").trim()).toBe(
      `-d -c ${dir}/tinyproxy.conf`,
    );
    // The relay, not a byte pipe: only POST /mcp reaches the tunnel.
    expect(readFileSync(join(dir, "node.args"), "utf8").trim()).toBe(
      "/opt/frm/mcp-relay.mjs",
    );
    expect(readFileSync(join(dir, "node.env"), "utf8").trim()).toBe(
      "3010 /mcp",
    );
    expect(GATEWAY_SCRIPT).not.toContain("socat");
  });

  test("an empty allowlist denies everything", () => {
    const script = GATEWAY_SCRIPT.replaceAll("/tmp/", `${dir}/`).replace(
      "sleep 5",
      "sleep 0.05",
    );
    try {
      execFileSync("sh", ["-c", script], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          FRM_EGRESS_ALLOW: "",
          FRM_MCP_PORT: "3010",
          FRM_PROXY_PORT: "8888",
        },
        timeout: 10_000,
      });
    } catch {
      // exits 1 once a child dies
    }
    expect(readFileSync(join(dir, "filter"), "utf8")).toBe("");
  });
});

describe("buildImage", () => {
  const scripts = new PlumbingScripts(
    "ctr-lab",
    layoutOf("/home/ops/frm"),
    "frm-internal",
  );
  const ran = (stdout: string, code = 0): Ran => ({ code, stdout, stderr: "" });

  function host(
    o: {
      tagged?: "ours" | "foreign";
      base?: boolean;
      /** What `git --version` reports inside the image; "" makes the run fail. */
      git?: string;
    } = {},
  ) {
    let tagged = o.tagged;
    const builds: Buffer[] = [];
    const run = async (command: string, _what: string, input?: Buffer) => {
      if (command.includes("docker run")) {
        return o.git === "" ? ran("", 1) : ran(o.git ?? "git version 2.51.0\n");
      }
      if (command.includes("docker build")) {
        builds.push(input ?? Buffer.alloc(0));
        tagged = "ours";
        return ran(`sha256:${"c".repeat(64)}\n`);
      }
      if (command.endsWith(" node:22-bookworm-slim")) {
        return o.base === false
          ? ran("", 1)
          : ran(`${BASE} 79900664 <no value>|<no value>\n`);
      }
      if (tagged === undefined) return ran("", 1);
      return ran(
        `sha256:${"c".repeat(64)} 377000000 ${tagged === "ours" ? "1|ctr-lab" : "<no value>|<no value>"}\n`,
      );
    };
    return { run, builds };
  }
  const deps = (run: ReturnType<typeof host>["run"]) => ({
    executorId: "ctr-lab",
    scripts,
    run,
    baseImage: "node:22-bookworm-slim",
    installs: SPEC.installs,
    shim: SPEC.shim,
    relay: SPEC.relay,
    gitPatched: DEFAULT_GIT_PATCHED,
  });

  test("resolves the base to its id, builds the tar over stdin, reports id, size and tag", async () => {
    const h = host();
    const built = await buildImage(deps(h.run));
    expect(built).toMatchObject({
      id: `sha256:${"c".repeat(64)}`,
      sizeBytes: 377_000_000,
      ours: true,
      built: true,
    });
    expect(built.tag).toBe(renderImage(SPEC).tag);
    expect(h.builds).toHaveLength(1);
    expect(h.builds[0]?.equals(renderImage(SPEC).tar)).toBe(true);
  });

  test("the same context already built is reused, not rebuilt", async () => {
    const h = host({ tagged: "ours" });
    expect(await buildImage(deps(h.run))).toMatchObject({ built: false });
    expect(h.builds).toHaveLength(0);
  });

  test("a tag without our labels is refused and left alone; a missing base is never pulled", async () => {
    await expect(
      buildImage(deps(host({ tagged: "foreign" }).run)),
    ).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining("not touching it"),
    });
    await expect(
      buildImage(deps(host({ base: false }).run)),
    ).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining("never pulled"),
    });
  });

  // The floor refuses a spawn too, but by then the image is recorded against the executor
  // and the failure names a session rather than the base that caused it.
  test("the built image's git is reported, and a base below the submodule floor is refused at build time", async () => {
    expect(await buildImage(deps(host().run))).toMatchObject({
      gitVersion: "2.51.0",
    });

    // Debian bookworm: the CVE-2025-48384 fix is backported under 2.39.5, so no version string can
    // tell it from an unpatched one — the case this ticket moved the base image for.
    await expect(
      buildImage(deps(host({ git: "git version 2.39.5\n" }).run)),
    ).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining(
        "2.39.5 is not fixed for CVE-2024-32002",
      ),
    });

    await expect(buildImage(deps(host({ git: "" }).run))).rejects.toMatchObject(
      {
        class: "validation",
        message: expect.stringContaining("cannot read git's version"),
      },
    );
    await expect(
      buildImage(deps(host({ git: "not a git\n" }).run)),
    ).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining("cannot read git's version"),
    });
  });

  test("a reused image is checked too: an executor never keeps one whose git cannot run submodules", async () => {
    const h = host({ tagged: "ours", git: "git version 2.39.5\n" });
    await expect(buildImage(deps(h.run))).rejects.toMatchObject({
      class: "validation",
      message: expect.stringContaining("2.39.5"),
    });
    expect(h.builds).toHaveLength(0);
  });
});
