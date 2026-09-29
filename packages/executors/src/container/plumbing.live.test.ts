// The container plumbing against the real docker host over ssh. Skipped unless
// FRM_CONTAINER=1:
//   FRM_CONTAINER=1 pnpm exec vitest run packages/executors/src/container/plumbing.live.test.ts
// FRM_CONTAINER_HOST (user@host, required) and FRM_CONTAINER_KEY (default
// ~/.ssh/id_ed25519) as in container.live.test.ts; the host key comes from the operator's
// ~/.ssh/known_hosts, never a scan. The image is built FROM the host's node:22-trixie-slim,
// resolved to its id and used read-only, with no runner install lines (runner-neutral and quick).
// A stand-in API answers /mcp with 401, as the real one does without a bearer, and records every
// request that reaches it: the gateway's relay must pass POST /mcp and nothing else.
// An interrupted build shows what a dropped link leaves behind. Every object is
// labelled frm.managed=1 + frm.executor=<this run's id>, removed by that label in afterAll, and
// the run asserts none is left; the other tenant's containers are compared by id, never touched.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GIT_PATCHED } from "@bayon/core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { readAll } from "../contract.js";
import { SlotCounter } from "../slots.js";
import {
  ContainerExecutorConfig,
  type ContainerExecutorConfigInput,
} from "./config.js";
import { ContainerExecutor } from "./container.js";
import { SshTransport } from "./ssh.js";
import { runRemote } from "./transport.js";

const LIVE = process.env["FRM_CONTAINER"] === "1";
const [USER = "", HOST = ""] = (process.env["FRM_CONTAINER_HOST"] ?? "").split(
  "@",
);
if (LIVE && (USER === "" || HOST === ""))
  throw new Error("FRM_CONTAINER=1 needs FRM_CONTAINER_HOST=user@host");
const KEY =
  process.env["FRM_CONTAINER_KEY"] ?? join(homedir(), ".ssh", "id_ed25519");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RUN = [...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join("");
const ID = `ctr-p${randomBytes(4).toString("hex")}`;
const ROOT = `/home/${USER}/frm/test/${RUN}`;
const ROOT_GUARD = new RegExp(
  `^/home/${USER}/frm/test/[0-9A-HJKMNP-TV-Z]{26}$`,
);
const ALLOWED = "registry.npmjs.org";
/** The base on the docker host: run by id or tag, never pulled, tagged or removed. */
const BASE_IMAGE = "node:22-trixie-slim";
const BLOCKED = "example.com";
const LABELS = `--filter label=frm.managed=1 --filter label=frm.executor=${ID}`;
const MINUTE = 60_000;
/** Evidence lines: printed, and appended to $FRM_PLUMB_REPORT when set (vitest hides passing logs). */
const REPORT = process.env["FRM_PLUMB_REPORT"];
const note = (line: string): void => {
  console.log(line);
  if (REPORT !== undefined) appendFileSync(REPORT, `${line}\n`);
};

let frmHome = "";
let knownHosts = "";
let api: Server;
let mcpUrl = "";
/** `<method> <url>` of every request the stand-in API received. */
const apiSeen: string[] = [];
let transport: SshTransport;
const executors: ContainerExecutor[] = [];

/** The fleet's limits: no floor of its own, so the executor's min_free_pct (5) governs. */
const FLEET = { clockSkewMaxMs: 5_000, minFreePct: 0 };

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
  image: "node:22-trixie-slim",
  network: `${ID}-internal`,
  heartbeat_ms: 1_000,
  kill_grace_ms: 2_000,
  min_free_pct: 5,
  ...over,
});

function executor(
  over: Partial<ContainerExecutorConfigInput> = {},
  withTunnel = true,
): ContainerExecutor {
  const ex = new ContainerExecutor({
    id: ID,
    slots: new SlotCounter(2),
    frmHome,
    config: config(over),
    egressHosts: [ALLOWED],
    ...(withTunnel ? { mcpUrl } : {}),
  });
  executors.push(ex);
  return ex;
}

const remote = async (command: string): Promise<string> =>
  (
    await runRemote(transport, command, {
      what: "live check",
      signal: AbortSignal.timeout(2 * MINUTE),
    })
  ).stdout;

/** Containers with no frm.managed label (the other tenant's): listed by id, never touched. */
async function otherTenant(): Promise<string[]> {
  return (
    await remote(
      `docker ps -a --no-trunc --format '{{.ID}} {{.Label "frm.managed"}}'`,
    )
  )
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && l.split(" ").length === 1)
    .toSorted();
}
let tenantBefore: readonly string[] = [];

/** Our labelled objects on the host, by kind. */
async function leftovers(): Promise<string> {
  return (
    await remote(
      [
        `echo "containers $(docker ps -aq ${LABELS} | wc -l)"`,
        `echo "decoys $(docker ps -aq --filter label=frm.test=${RUN} | wc -l)"`,
        `echo "networks $(docker network ls -q ${LABELS} | wc -l)"`,
        `echo "images $(docker image ls -aq ${LABELS} | wc -l)"`,
      ].join("\n"),
    )
  ).trim();
}

describe.skipIf(!LIVE)(`container plumbing on ${HOST}`, () => {
  let tag = "";
  let ex: ContainerExecutor;

  beforeAll(async () => {
    frmHome = mkdtempSync(join(tmpdir(), "frm-plumb-"));
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
    api = createServer((req, res) => {
      apiSeen.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
      res.writeHead(req.url === "/mcp" ? 401 : 404, {
        "www-authenticate": "Bearer",
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    mcpUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/mcp`;
    tenantBefore = await otherTenant();
    note(`other tenant: ${tenantBefore.length} unlabelled containers before`);
  });

  afterAll(async () => {
    for (const e of executors) await e.close();
    await new Promise((resolve) => api.close(resolve));
    await remote(
      [
        `docker ps -aq ${LABELS} | xargs -r docker rm -f >/dev/null`,
        // The decoy that stands for an unlabelled leftover: this run's own, by its own label.
        `docker ps -aq --filter label=frm.test=${RUN} | xargs -r docker rm -f >/dev/null`,
        `docker network ls -q ${LABELS} | xargs -r docker network rm >/dev/null`,
        // Every labelled image, intermediates included; a parent goes once its children have.
        `for i in 1 2 3 4 5 6; do ids=$(docker image ls -aq --no-trunc ${LABELS} | sort -u); [ -z "$ids" ] && break; echo "$ids" | xargs docker image rm >/dev/null 2>&1 || true; done`,
      ].join("\n"),
    );
    if (ROOT_GUARD.test(ROOT)) await remote(`rm -rf ${ROOT}`);
    const left = await leftovers();
    note(
      `teardown: labelled objects left for ${ID}: ${left.replaceAll("\n", ", ")}`,
    );
    const tenantAfter = await otherTenant();
    note(
      `other tenant: ${tenantBefore.length} unlabelled containers before, ${tenantAfter.length} after, ${tenantBefore.filter((c) => !tenantAfter.includes(c)).length} missing`,
    );
    expect(tenantAfter).toEqual(expect.arrayContaining([...tenantBefore]));
    await transport.close(AbortSignal.timeout(5_000));
    rmSync(frmHome, { recursive: true, force: true });
    expect(left).toBe("containers 0\ndecoys 0\nnetworks 0\nimages 0");
  }, 5 * MINUTE);

  test(
    "builds the runner-neutral image FROM the base's id: labelled, tagged by its hash, reused",
    async () => {
      const builder = executor({}, false);
      const built = await builder.buildImage([], DEFAULT_GIT_PATCHED);
      tag = built.tag;
      note(
        `image: ${built.tag} ${built.id} ${Math.round(built.sizeBytes / 1e6)} MB (built: ${built.built})`,
      );
      expect(built.tag).toMatch(new RegExp(`^frm-${ID}:[0-9a-f]{12}$`));
      expect(built).toMatchObject({ ours: true, built: true });
      const labels = await remote(
        `docker image inspect -f '{{json .Config.Labels}}' ${built.tag}`,
      );
      expect(JSON.parse(labels)).toMatchObject({
        "frm.managed": "1",
        "frm.executor": ID,
        "frm.image": built.hash,
      });
      expect(await builder.buildImage([], DEFAULT_GIT_PATCHED)).toMatchObject({
        id: built.id,
        built: false,
      });
      expect(await builder.pruneImages(built.id)).toEqual({
        removed: [],
        kept: [],
      });
    },
    30 * MINUTE,
  );

  test(
    "an ssh drop mid-build: the daemon runs the orphaned build to its end; all it leaves is labelled and goes by label",
    async () => {
      const tenant = await otherTenant();
      const builder = executor({ timeouts: { build_ms: 20_000 } }, false);
      // A step that outlives the deadline: the executor kills its ssh client mid-build, as a
      // dropped link would.
      await expect(
        builder.buildImage(["sleep 60"], DEFAULT_GIT_PATCHED),
      ).rejects.toMatchObject({
        class: "timeout",
      });
      const during = await builder.buildLeftovers({ fresh: true });
      note(`build leftovers right after the drop: ${JSON.stringify(during)}`);
      // The legacy builder does not stop when its client goes: it runs the build to its end.
      // Settled once no step of it exists, in any state, across five polls (between two steps a
      // build holds no container, but only for a moment).
      const steps = async () =>
        (
          await remote(
            `docker ps -a --no-trunc --format '{{.Command}}' | grep -c 'frm.executor=${ID}[^a-z0-9-]' || true`,
          )
        ).trim();
      let quiet = 0;
      await vi.waitFor(
        async () => {
          quiet = (await steps()) === "0" ? quiet + 1 : 0;
          expect(quiet).toBeGreaterThanOrEqual(5);
        },
        { timeout: 5 * MINUTE, interval: 2_000 },
      );
      const settled = await builder.buildLeftovers({ fresh: true });
      note(
        `build leftovers once the orphaned build ended: ${JSON.stringify(settled)}`,
      );
      // LABEL is the Dockerfile's first instruction: every step's container and image carries it.
      expect(settled.unlabelled).toEqual([]);
      const removed = await builder.pruneBuildLeftovers();
      const images = await builder.pruneImages(
        (await remote(`docker image inspect -f '{{.Id}}' ${tag}`)).trim(),
      );
      note(
        `removed by label: ${removed.removed.length} build container(s), ${images.removed.length} image(s) (${images.removed.join(", ")})`,
      );
      const after = await builder.buildLeftovers({ fresh: true });
      note(
        `build leftovers after the label-scoped removal: ${JSON.stringify(after)}`,
      );
      expect(after).toEqual({ labelled: [], unlabelled: [], capped: false });
      expect(await otherTenant()).toEqual(expect.arrayContaining(tenant));
    },
    10 * MINUTE,
  );

  test(
    "a labelled stopped build container goes by label; one with our marker and executor but no frm.managed is reported and never touched",
    async () => {
      const builder = executor({}, false);
      const step = `/bin/sh -c ': frm.executor=${ID} && true'`;
      // As a builder would leave them: created, never started, the build marker in the command.
      const ours = (
        await remote(
          `docker create --pull never --label frm.managed=1 --label frm.executor=${ID} ${BASE_IMAGE} ${step}`,
        )
      ).trim();
      const decoy = (
        await remote(
          `docker create --pull never --label frm.test=${RUN} --label frm.executor=${ID} ${BASE_IMAGE} ${step}`,
        )
      ).trim();
      // The decoy runs the base image, so it inherits no frm.managed label from ours.
      expect(
        (
          await remote(
            `docker inspect -f '{{index .Config.Labels "frm.managed"}}' ${decoy}`,
          )
        ).trim(),
      ).toBe("");
      const found = await builder.buildLeftovers({ fresh: true });
      note(
        `build leftovers with a labelled one and a decoy: ${JSON.stringify(found)}`,
      );
      expect(found.labelled).toEqual([`ctr:${ours.slice(0, 12)}`]);
      expect(found.unlabelled).toEqual([`ctr:${decoy.slice(0, 12)}`]);
      const removed = await builder.pruneBuildLeftovers();
      note(`removed by label: ${JSON.stringify(removed)}`);
      expect(removed).toEqual({ removed: [ours.slice(0, 12)], kept: [] });
      const exists = async (id: string) =>
        (
          await remote(`docker inspect -f ok ${id} 2>/dev/null || echo gone`)
        ).trim();
      expect(await exists(ours)).toBe("gone");
      expect(await exists(decoy)).toBe("ok");
      expect(await builder.buildLeftovers({ fresh: true })).toEqual({
        labelled: [],
        unlabelled: [`ctr:${decoy.slice(0, 12)}`],
        capped: false,
      });
    },
    3 * MINUTE,
  );

  test(
    "health: ssh, docker, disk, clock, the image, the tunnel and /mcp answering 401 through the gateway",
    async () => {
      ex = executor({ image: tag });
      let detail: Readonly<Record<string, unknown>> = {};
      await vi.waitFor(
        async () => {
          const report = await ex.health(FLEET);
          detail = report.detail;
          expect(report.detail["failures"]).toEqual([]);
          expect(report.healthy).toBe(true);
        },
        { timeout: 2 * MINUTE, interval: 1_000 },
      );
      note(`health: ${JSON.stringify(detail)}`);
      expect(detail).toMatchObject({
        image_present: true,
        tunnel: "up",
        mcp: "401",
        // A REST path through the gateway is refused by the relay itself.
        relay: "404|refused",
        docker: expect.stringMatching(/^\d+\.\d+/),
      });
      expect(detail["rtt_ms"]).toBeGreaterThan(0);
      expect(Math.abs(Number(detail["clock_skew_ms"]))).toBeLessThan(5_000);
      const network = await remote(
        `docker network inspect -f '{{.Internal}} {{index .Labels "frm.executor"}}' ${ID}-internal`,
      );
      expect(network.trim()).toBe(`true ${ID}`);
      // A gateway already running this configuration is kept, never replaced.
      const gateway = async () =>
        (
          await remote(
            `docker inspect -f '{{.Id}} {{.RestartCount}}' frm-${ID}-gateway`,
          )
        ).trim();
      const before = await gateway();
      await ex.ensureGateway();
      expect(await gateway()).toBe(before);
      note(`gateway kept across ensureGateway: ${before}`);
      // The gateway's own limits: the relay's 64 connections fit in nofile 1024.
      const limits = await remote(
        `docker inspect -f '{{range .HostConfig.Ulimits}}{{.Name}}={{.Soft}}:{{.Hard}} {{end}}' frm-${ID}-gateway`,
      );
      note(`gateway ulimits: ${limits.trim()}`);
      expect(limits).toContain("nofile=1024:1024");
    },
    3 * MINUTE,
  );

  test(
    "from a session container: the allowlisted host is reachable, example.com is not, /mcp answers",
    async () => {
      const prepared = await ex.prepare({
        sessionId: "ses-egress",
        root: "/x/ses-egress",
      });
      expect(prepared).toEqual({
        root: "/frm/s/ses-egress",
        mcpUrl: `http://frm-${ID}-gateway:3010/mcp`,
        proxyUrl: `http://frm-${ID}-gateway:8888`,
      });
      const probe = [
        'const http = require("node:http");',
        "const connect = (host) => new Promise((resolve) => {",
        "  const u = new URL(process.env.PROXY);",
        '  const req = http.request({ host: u.hostname, port: u.port, method: "CONNECT", path: host + ":443", timeout: 15000 });',
        '  req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });',
        '  req.on("error", (e) => resolve("error:" + e.code));',
        '  req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));',
        "  req.end();",
        "});",
        'const status = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }).then((r) => r.status, (e) => "error:" + (e.cause?.code ?? e.name));',
        "(async () => console.log(JSON.stringify({",
        `  allowed: await connect("${ALLOWED}"),`,
        `  blocked: await connect("${BLOCKED}"),`,
        `  direct: await status("https://${BLOCKED}/"),`,
        '  mcp: await status(process.env.MCP, { method: "POST" }),',
        "})))();",
      ].join("\n");
      const proc = await ex.exec(["node", "-e", probe], {
        cwd: prepared.root,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          PROXY: prepared.proxyUrl ?? "",
          MCP: prepared.mcpUrl ?? "",
        },
        stdin: "ignore",
      });
      const [out, errText, exit] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
        proc.exited,
      ]);
      note(
        `egress from the session container: ${out.trim()} ${errText.trim()}`,
      );
      expect(exit).toEqual({ code: 0, signal: null });
      const seen = JSON.parse(out) as Record<string, unknown>;
      expect(seen).toMatchObject({ allowed: 200, blocked: 403, mcp: 401 });
      expect(String(seen["direct"])).toMatch(/^error:/);
    },
    3 * MINUTE,
  );

  test(
    "from a session container, the relay passes POST /mcp and refuses every other path, method and upgrade",
    async () => {
      const prepared = await ex.prepare({
        sessionId: "ses-relay",
        root: "/x/ses-relay",
      });
      // Raw requests over TCP: no client library normalises a path before the relay sees it.
      const probe = String.raw`
const net = require("node:net");
const u = new URL(process.env.MCP);
const send = (raw) => new Promise((resolve) => {
  const s = net.connect(Number(u.port), u.hostname);
  let text = "";
  s.setTimeout(8000, () => s.destroy());
  s.on("data", (c) => (text += c.toString("latin1")));
  s.on("error", (e) => resolve("error:" + e.code));
  s.on("close", () => {
    const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map((m) => m[1]);
    const mark = /x-frm-relay: (\w+)/i.exec(text)?.[1] ?? "-";
    resolve(statuses.join(",") + "|" + mark);
  });
  s.write(raw);
});
const req = (m, t) => m + " " + t + " HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}";
const probes = {
  post_mcp: req("POST", "/mcp"),
  get_mcp: req("GET", "/mcp"),
  delete_mcp: req("DELETE", "/mcp"),
  rest: req("POST", "/api/v1/tickets"),
  rest_get: req("GET", "/api/v1/executors"),
  dotdot: req("POST", "/mcp/../api/v1/tickets"),
  encoded_dots: req("POST", "/mcp/%2e%2e/api/v1/tickets"),
  encoded_slash: req("POST", "/mcp%2F..%2Fapi%2Fv1%2Ftickets"),
  encoded_path: req("POST", "/%6Dcp"),
  double_slash: req("POST", "//mcp"),
  query: req("POST", "/mcp?x=1"),
  absolute: req("POST", "http://127.0.0.1:3000/api/v1/tickets"),
  websocket: "GET /mcp HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  ws_path: "GET /ws HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  connect: "CONNECT 127.0.0.1:22 HTTP/1.1\r\nHost: 127.0.0.1:22\r\n\r\n",
  pipelined: "POST /mcp HTTP/1.1\r\nHost: " + u.host + "\r\nContent-Length: 2\r\n\r\n{}GET /api/v1/tickets HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: close\r\n\r\n",
};
(async () => {
  const out = {};
  for (const [name, raw] of Object.entries(probes)) out[name] = await send(raw);
  console.log(JSON.stringify(out));
})();`;
      const seenBefore = apiSeen.length;
      const proc = await ex.exec(["node", "-e", probe], {
        cwd: prepared.root,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          MCP: prepared.mcpUrl ?? "",
        },
        stdin: "ignore",
      });
      const [out, errText, exit] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
        proc.exited,
      ]);
      note(
        `relay probes from the session container: ${out.trim()} ${errText.trim()}`,
      );
      expect(exit).toEqual({ code: 0, signal: null });
      expect(JSON.parse(out)).toEqual({
        post_mcp: "401|-",
        get_mcp: "405|refused",
        delete_mcp: "405|refused",
        rest: "404|refused",
        rest_get: "404|refused",
        dotdot: "404|refused",
        encoded_dots: "404|refused",
        encoded_slash: "404|refused",
        encoded_path: "404|refused",
        double_slash: "404|refused",
        query: "404|refused",
        absolute: "404|refused",
        websocket: "403|refused",
        ws_path: "403|refused",
        connect: "403|refused",
        pipelined: "401,404|refused",
      });
      // Only POST /mcp ever reached the API, from these probes or anything else in this run.
      const reached = apiSeen.slice(seenBefore);
      note(
        `the API saw: ${JSON.stringify(reached)}; in the whole run: ${new Set(apiSeen).size} distinct`,
      );
      expect(reached).toEqual(["POST /mcp", "POST /mcp"]);
      expect([...new Set(apiSeen)]).toEqual(["POST /mcp"]);
    },
    3 * MINUTE,
  );

  test(
    "from one session container, the relay holds 16 connections at once and closes the rest unanswered",
    async () => {
      const prepared = await ex.prepare({
        sessionId: "ses-cap",
        root: "/x/ses-cap",
      });
      // Twenty connections from one container; after they settle, each still open sends POST /mcp.
      const probe = String.raw`
const net = require("node:net");
const u = new URL(process.env.MCP);
const N = 20;
const socks = [];
for (let i = 0; i < N; i++) {
  const c = { s: net.connect(Number(u.port), u.hostname), text: "", closed: false };
  c.s.on("data", (d) => (c.text += d.toString("latin1")));
  c.s.on("error", () => {});
  c.s.on("close", () => (c.closed = true));
  socks.push(c);
}
setTimeout(() => {
  const refused = socks.filter((c) => c.closed).length;
  for (const c of socks) {
    if (!c.closed) c.s.write("POST /mcp HTTP/1.1\r\nHost: " + u.host + "\r\nConnection: close\r\nContent-Length: 2\r\n\r\n{}");
  }
  setTimeout(() => {
    const answered = socks.filter((c) => /^HTTP\/1\.1 401 /.test(c.text)).length;
    console.log(JSON.stringify({ opened: N, closed_unanswered: refused, answered }));
    process.exit(0);
  }, 5000);
}, 2000);`;
      const seenBefore = apiSeen.length;
      const proc = await ex.exec(["node", "-e", probe], {
        cwd: prepared.root,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          MCP: prepared.mcpUrl ?? "",
        },
        stdin: "ignore",
      });
      const [out, errText, exit] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
        proc.exited,
      ]);
      note(
        `connection cap from one session container: ${out.trim()} ${errText.trim()}`,
      );
      expect(exit).toEqual({ code: 0, signal: null });
      expect(JSON.parse(out)).toEqual({
        opened: 20,
        closed_unanswered: 4,
        answered: 16,
      });
      expect(apiSeen.slice(seenBefore)).toEqual(
        Array.from({ length: 16 }, () => "POST /mcp"),
      );
    },
    3 * MINUTE,
  );

  test(
    "killing the tunnel marks the executor unhealthy; its restart brings /mcp back",
    async () => {
      const pid = ex.tunnelPid();
      expect(pid).not.toBeNull();
      process.kill(pid ?? 0, "SIGKILL");
      const report = await ex.health(FLEET);
      note(`health after killing the tunnel: ${JSON.stringify(report.detail)}`);
      expect(report.healthy).toBe(false);
      expect(String(report.detail["failures"])).toMatch(/^(?:tunnel|mcp): /);
      await vi.waitFor(
        async () => expect((await ex.health(FLEET)).healthy).toBe(true),
        { timeout: 2 * MINUTE, interval: 1_000 },
      );
      expect(ex.tunnelPid()).not.toBe(pid);
    },
    5 * MINUTE,
  );

  test(
    "over the quota, health cleans up the largest session (hard), not only reports it",
    async () => {
      // The session starts under the normal quota (prepare refuses over it); a second instance
      // of the same executor with a tiny quota is the one whose health finds it over.
      const prepared = await ex.prepare({
        sessionId: "ses-big",
        root: "/x/ses-big",
      });
      const tight = executor({ image: tag, quota_gb: 1e-6 }, false);
      // A megabyte makes it the largest session; the program then keeps running.
      const proc = await ex.exec(
        [
          "node",
          "-e",
          'require("node:fs").writeFileSync("big", Buffer.alloc(1e6)); setInterval(() => {}, 1 << 30)',
        ],
        {
          cwd: prepared.root,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          stdin: "ignore",
        },
      );
      void readAll(proc.stdout);
      void readAll(proc.stderr);
      await vi.waitFor(
        async () =>
          expect(
            (
              await remote(`test -f ${ROOT}/work/ses-big/big && echo yes`)
            ).trim(),
          ).toBe("yes"),
        { timeout: 30_000, interval: 500 },
      );
      const report = await tight.health(FLEET);
      note(`health over quota: ${JSON.stringify(report.detail)}`);
      expect(report.healthy).toBe(false);
      expect(report.detail["reclaimed"]).toBe("ses-big");
      expect(String(report.detail["failures"])).toContain("over quota_gb");
      await expect(proc.exited).resolves.toMatchObject({ signal: "SIGKILL" });
    },
    3 * MINUTE,
  );
});
