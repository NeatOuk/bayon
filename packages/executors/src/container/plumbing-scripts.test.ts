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
import {
  PlumbingScripts,
  parseClock,
  parseLeftovers,
  type GatewaySpec,
} from "./plumbing-scripts.js";
import { layoutOf } from "./route.js";

const ID = "ctr-lab";
const LABELS = `--filter label=frm.managed=1 --filter label=frm.executor=${ID}`;
const layout = layoutOf("/home/ops/frm");
const scripts = new PlumbingScripts(ID, layout, "frm-internal");
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const TAG = "frm-ctr-lab:0123456789ab";
const GATEWAY: GatewaySpec = {
  image: TAG,
  allow: ["api.example.com", "registry.npmjs.org"],
  mcpPort: 3010,
  mcpPath: "/mcp",
  proxyPort: 8888,
  cfg: "0123456789ab",
};
const every = (): Record<string, string> => ({
  imageInfo: scripts.imageInfo(TAG),
  imageGitVersion: scripts.imageGitVersion(TAG),
  build: scripts.build(TAG, "c".repeat(64)),
  prune: scripts.prune(IMAGE_ID),
  ensureGateway: scripts.ensureGateway(GATEWAY),
  resetSocket: scripts.resetSocket(),
  clock: scripts.clock(),
  health: scripts.health(TAG, null),
  healthWithMcp: scripts.health(TAG, { port: 3010, path: "/mcp" }),
  buildLeftovers: scripts.buildLeftovers(),
  pruneBuildLeftovers: scripts.pruneBuildLeftovers(),
});

describe("plumbing scripts", () => {
  test("every script is valid sh", () => {
    for (const script of Object.values(every())) {
      execFileSync("sh", ["-n", "-c", script]);
    }
  });

  test("every label filter is ANDed with frm.managed=1 and this executor's id", () => {
    const filtered = Object.entries(every()).flatMap(([name, script]) =>
      script
        .split("\n")
        .filter((line) => line.includes("--filter label="))
        .map((line) => [name, line] as const),
    );
    expect(filtered.length).toBeGreaterThanOrEqual(4);
    for (const [name, line] of filtered) {
      expect(line, name).toContain(LABELS);
    }
  });

  test("removals take ids only from labelled listings; images are never forced, nothing is pruned", () => {
    const all = Object.values(every()).join("\n");
    expect(all).not.toMatch(/\bprune\b|docker rmi|volume|--force(?![-\w])/);
    const prune = scripts.prune(IMAGE_ID);
    expect(prune).toContain(`docker image ls -q --no-trunc ${LABELS} |`);
    expect(prune).toContain(`keep=${IMAGE_ID}`);
    expect(prune).toContain('docker image rm "$i" >/dev/null');
    expect(prune).not.toMatch(/image rm -f/);
    const removals = scripts
      .ensureGateway(GATEWAY)
      .split("\n")
      .filter((line) => /docker (?:rm|network rm)/.test(line));
    expect(removals).toEqual([
      `docker ps -aq ${LABELS} --filter label=frm.role=gateway | xargs -r docker rm -f >/dev/null`,
    ]);
  });

  // `--rm` only covers a normal exit; a restarted daemon or a killed ssh leaves
  // the container, and an unlabelled, markerless one on the shared host is invisible to every
  // reaper — `buildLeftovers` matches the marker, `pruneBuildLeftovers` the labels and the marker.
  test("every docker run carries our two labels and --pull never; the git check names the marker", () => {
    const runs = Object.entries(every()).flatMap(([name, script]) =>
      script
        .split("\n")
        .filter((line) => /\bdocker run\b/.test(line))
        .map((line) => [name, line] as const),
    );
    expect(runs.length).toBeGreaterThanOrEqual(2);
    for (const [name, line] of runs) {
      expect(line, name).toContain(
        `--label frm.managed=1 --label frm.executor=${ID}`,
      );
      expect(line, name).toMatch(/--pull never/);
    }
    const check = scripts.imageGitVersion(TAG);
    expect(check).toContain("--network none");
    expect(check).toContain(`-c ': frm.executor=${ID} && exec git --version'`);
    // What the two reapers match on, so a leftover of this run is found and removed like a build's.
    expect(check).toMatch(new RegExp(`frm\\.executor=${ID}[^a-z0-9-]`));
  });

  test("the build: the legacy builder, --force-rm, never a pull, our labels, the context on stdin", () => {
    expect(scripts.build(TAG, "c".repeat(64))).toBe(
      `DOCKER_BUILDKIT=0 exec docker build --force-rm --pull=false -q --label frm.managed=1 --label frm.executor=${ID} --label frm.image=${"c".repeat(64)} -t ${TAG} -`,
    );
  });

  test("the networks: created with our labels (the sessions' one internal), a foreign one refused", () => {
    const script = scripts.ensureGateway(GATEWAY);
    expect(script).toContain(
      `docker network create $i --label frm.managed=1 --label frm.executor=${ID} "$1"`,
    );
    expect(script).toContain('if [ "$2" = true ]; then i=--internal;');
    expect(script).toContain(
      "net frm-internal true\nnet frm-ctr-lab-egress false",
    );
    expect(script).toContain(`"$2|1|${ID}") ;;`);
    expect(script).toMatch(/\*\) echo "network \$1 is not ours .*exit 4 ;;/);
  });

  test("the gateway: kept while it runs this config, else replaced; labelled, capped, read-only", () => {
    const script = scripts.ensureGateway(GATEWAY);
    expect(script).toContain(
      `docker ps -q ${LABELS} --filter label=frm.role=gateway --filter label=frm.gateway=0123456789ab --filter status=running`,
    );
    expect(script).toContain(
      "if [ -n \"$(docker ps -aq --filter 'name=^/frm-ctr-lab-gateway$')\" ]; then",
    );
    const run =
      script.split("\n").find((line) => line.startsWith("docker run")) ?? "";
    for (const flag of [
      "--init --pull never --restart unless-stopped",
      "--name frm-ctr-lab-gateway",
      `--label frm.managed=1 --label frm.executor=${ID}`,
      "--label frm.role=gateway --label frm.gateway=0123456789ab",
      '--user "$(id -u):$(id -g)"',
      "--cpus 1 --memory 256m --memory-swap 256m --pids-limit 128 --ulimit core=0 --ulimit nofile=1024:1024",
      "--cap-drop ALL --security-opt no-new-privileges --read-only",
      "--network frm-ctr-lab-egress --network frm-internal",
      "--mount type=bind,src=/home/ops/frm/run,dst=/frm/run,readonly",
      "-e FRM_EGRESS_ALLOW=api.example.com,registry.npmjs.org",
      "-e FRM_MCP_PORT=3010 -e FRM_MCP_PATH=/mcp -e FRM_PROXY_PORT=8888",
      `${TAG} /opt/frm/gateway.sh`,
    ]) {
      expect(run).toContain(flag);
    }
  });

  test("health: docker and the image always; /mcp through the running gateway only with a tunnel", () => {
    expect(scripts.health(TAG, null)).not.toContain("mcp");
    const withMcp = scripts.health(TAG, { port: 3010, path: "/mcp" });
    expect(withMcp).toContain(`docker image inspect ${TAG}`);
    expect(withMcp).toContain(
      `docker ps -q ${LABELS} --filter label=frm.role=gateway --filter status=running`,
    );
    expect(withMcp).toContain('fetch("http://127.0.0.1:3010/mcp",o)');
    // A REST path through the relay: its own refusal proves it filters.
    expect(withMcp).toContain(
      'fetch("http://127.0.0.1:3010/api/v1/executors",o)',
    );
    expect(withMcp).toContain('r.headers.get("x-frm-relay")');
    // The leftover scan is its own, less frequent round trip: never in the health probe.
    expect(withMcp).not.toContain("docker history");
  });

  test("the probe's node program is valid JavaScript and prints both tagged lines", () => {
    const withMcp = scripts.health(TAG, { port: 3010, path: "/mcp" });
    const js = /node -e '([^']+)'/.exec(withMcp)?.[1] ?? "";
    // Nothing listens on :1 here: both fetches fail, and both lines still come out.
    const out = execFileSync(
      process.execPath,
      ["-e", js.replaceAll("127.0.0.1:3010", "127.0.0.1:1")],
      { encoding: "utf8" },
    );
    expect(out.trim().split("\n")).toEqual([
      expect.stringMatching(/^mcp error:/),
      expect.stringMatching(/^relay error:/),
    ]);
  });

  test("the gateway gets the relay's path, pattern-checked", () => {
    expect(() =>
      scripts.ensureGateway({ ...GATEWAY, mcpPath: "/mcp'$(x)" }),
    ).toThrow(/mcp path/);
    expect(() => scripts.ensureGateway({ ...GATEWAY, mcpPath: "mcp" })).toThrow(
      /mcp path/,
    );
  });

  test("the tunnel's socket lives in remote_root/run and is removed before each start", () => {
    expect(scripts.socket).toBe("/home/ops/frm/run/mcp.sock");
    expect(scripts.resetSocket()).toBe(
      "umask 077\nmkdir -p /home/ops/frm/run\nrm -f /home/ops/frm/run/mcp.sock",
    );
  });

  test("refuses every token that is not what it claims to be", () => {
    expect(() => new PlumbingScripts("Bad_Id", layout, "frm-internal")).toThrow(
      /executor id/,
    );
    expect(() => new PlumbingScripts(ID, layout, "a b")).toThrow(/network/);
    expect(() => new PlumbingScripts(ID, layoutOf("/a b"), "n")).toThrow(
      /path/,
    );
    expect(() => scripts.imageInfo("x;reboot")).toThrow(/image/);
    expect(() => scripts.build("frm:ok", "not-hex")).toThrow(/render hash/);
    expect(() => scripts.build("$(x)", "c".repeat(64))).toThrow(/tag/);
    expect(() => scripts.prune(TAG)).toThrow(/image id/);
    for (const allow of [
      ["Example.com"],
      ["a.b;reboot"],
      ["localhost"],
      ["a b.c"],
    ]) {
      expect(() => scripts.ensureGateway({ ...GATEWAY, allow })).toThrow(
        /egress host/,
      );
    }
    expect(() => scripts.ensureGateway({ ...GATEWAY, cfg: "zz" })).toThrow(
      /digest/,
    );
    expect(() => scripts.ensureGateway({ ...GATEWAY, mcpPort: 0 })).toThrow(
      /port/,
    );
    expect(() => scripts.ensureGateway({ ...GATEWAY, image: "a'b" })).toThrow(
      /image/,
    );
    expect(() =>
      scripts.health(TAG, { port: 3010, path: "/mcp'$(x)" }),
    ).toThrow(/mcp path/);
  });
});

describe("build leftovers", () => {
  test("the scan is read-only: it removes, stops or execs nothing", () => {
    const scan = scripts.buildLeftovers();
    expect(scan).not.toMatch(
      /docker (?:rm|rmi|stop|kill|exec|image rm|network rm|container rm)\b|\bprune\b/,
    );
    expect(scan).toContain(`m='frm.executor=${ID}'`);
  });

  test("the removal lists by label only, skips sessions and the gateway, and never forces", () => {
    const prune = scripts.pruneBuildLeftovers();
    const listing =
      prune.split("\n").find((l) => l.startsWith("docker ps")) ?? "";
    expect(listing).toContain(
      `docker ps -a --no-trunc ${LABELS} --filter status=created --filter status=exited --filter status=dead`,
    );
    expect(prune.match(/docker ps/g)).toHaveLength(1);
    expect(prune).toContain('if [ -n "$s" ] || [ -n "$r" ]; then continue; fi');
    expect(prune).toContain('docker rm "$i"');
    expect(prune).not.toMatch(/rm -f|--force|\bprune\b|image rm|rmi/);
  });

  describe("against a stand-in docker holding another tenant's objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "frm-leftovers-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const id = (c: string) => c.repeat(64);
    const MARK = `/bin/sh -c ': frm.executor=${ID} && sleep 120'`;
    // Every container on the host (an unfiltered listing), and what a labelled one returns.
    const all = [
      `${id("a")}|1|${ID}|"${MARK}"`, // ours, labelled: a build leftover
      `${id("b")}|||"${MARK}"`, // our build's, without labels
      `${id("c")}|||"node server.js"`, // the other tenant's
      `${id("d")}|1|${ID}|"sleep infinity"`, // our session container
      `${id("7")}|||"/bin/sh -c ': frm.executor=${ID}0 && x'"`, // another executor, our id + "0"
      `${id("6")}|1|ctr-999|"/bin/sh -c '#(nop) ' 'LABEL frm.managed=1 frm.executor=${ID}'"`,
    ];
    const labelled = [
      `${id("a")}|||"${MARK}"`,
      `${id("e")}|S1||"${MARK}"`, // a session's (contrived): skipped
      `${id("9")}||gateway|"/opt/frm/gateway.sh"`, // the gateway: skipped
      `${id("8")}|||"sleep infinity"`, // not a build step: skipped
    ];
    const bin = join(dir, "bin");
    const calls = join(dir, "calls");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(dir, "all"), `${all.join("\n")}\n`);
    writeFileSync(join(dir, "labelled"), `${labelled.join("\n")}\n`);
    writeFileSync(
      join(bin, "docker"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${calls}"`,
        'case "$1 $2" in',
        `  "ps -a") case "$*" in *label=frm.managed=1*) cat "${dir}/labelled";; *) cat "${dir}/all";; esac;;`,
        `  "image ls") printf 'sha256:${id("1")}\nsha256:${id("2")}\nsha256:${id("3")}\n';;`,
        '  "history --no-trunc") case "$*" in',
        `    *${id("1")}*|*${id("2")}*) echo "/bin/sh -c : frm.executor=${ID} && apt-get update";;`,
        '    *) echo "CMD [\\"node\\"]";; esac;;',
        `  "image inspect") case "$*" in *${id("1")}*) echo "1|${ID}";; *) echo "";; esac;;`,
        '  "rm "*) exit 0;;',
        '  *) echo "unexpected docker $*" >&2; exit 9;;',
        "esac",
      ].join("\n"),
    );
    chmodSync(join(bin, "docker"), 0o755);
    const run = (script: string) =>
      execFileSync("sh", ["-c", script], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
      });

    test("the scan names only our builds' objects, labelled or not, and changes nothing", () => {
      writeFileSync(calls, "");
      const found = parseLeftovers(run(scripts.buildLeftovers()));
      expect(found).toEqual({
        labelled: [`ctr:${"a".repeat(12)}`, `img:${"1".repeat(12)}`],
        unlabelled: [
          `ctr:${"6".repeat(12)}`,
          `ctr:${"b".repeat(12)}`,
          `img:${"2".repeat(12)}`,
        ],
        capped: false,
      });
      expect(readFileSync(calls, "utf8")).not.toMatch(/^rm /m);
    });

    test("the removal names only labelled, stopped build containers, one by one", () => {
      writeFileSync(calls, "");
      const out = run(scripts.pruneBuildLeftovers());
      expect(out.trim()).toBe(`removed ctr ${"a".repeat(12)}`);
      const removals = readFileSync(calls, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("rm "));
      expect(removals).toEqual([`rm ${id("a")}`]);
    });
  });

  test("parseLeftovers keeps well-formed lines only, deduplicated and sorted", () => {
    expect(
      parseLeftovers(
        [
          "docker 29.1.3",
          `leftover ctr ${"b".repeat(12)} unlabelled`,
          `leftover ctr ${"b".repeat(12)} unlabelled`,
          `leftover img ${"1".repeat(12)} labelled`,
          "leftover ctr xyz unlabelled",
          `leftover vol ${"c".repeat(12)} labelled`,
          "leftover-scan capped",
        ].join("\n"),
      ),
    ).toEqual({
      labelled: [`img:${"1".repeat(12)}`],
      unlabelled: [`ctr:${"b".repeat(12)}`],
      capped: true,
    });
  });
});

test("parseClock reads nanoseconds, milliseconds and bare seconds; anything else is null", () => {
  expect(parseClock("1789319241601585495\n")).toBe(1_789_319_241_602);
  expect(parseClock("1789319241601")).toBe(1_789_319_241_601);
  expect(parseClock("1789319241")).toBe(1_789_319_241_000);
  expect(parseClock("1789319241N")).toBeNull();
  expect(parseClock("")).toBeNull();
});
