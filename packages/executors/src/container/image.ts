// The runner-neutral image of a container executor: its base by
// image id (never pulled, never tagged), git, tini, the gateway's tinyproxy and /mcp relay
//, the exec-shim, and each runner's `containerInstall` lines from its adapter defaults
// (Invariant 1: the lines are opaque here). The build context is a deterministic tar; the tag is its
// hash. Every step names the executor (buildMarker), so a build's leftovers are found exactly.
import { createHash } from "node:crypto";
import { gitVersionProblem, parseGitVersion } from "@bayon/core";
import { frmError } from "../errors.js";
import type { PlumbingScripts } from "./plumbing-scripts.js";
import { EXECUTOR_ID } from "./ref.js";
import { tarball } from "./tar.js";
import type { Ran } from "./transport.js";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** A docker repository path component. */
const REPOSITORY = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
/** One Dockerfile RUN line: no line breaks, no continuation. */
const INSTALL = /^[^\r\n\\]+$/;
const PACKAGES = "ca-certificates git tini tinyproxy";

/**
 * The gateway's entrypoint. tinyproxy lets sessions reach only $FRM_EGRESS_ALLOW (default deny,
 * CONNECT to 443 only); the relay (mcp-relay.mjs) takes :$FRM_MCP_PORT and passes only an exact
 * POST $FRM_MCP_PATH to /frm/run/mcp.sock, the supervisor's reverse tunnel to the API.
 * Either one dying ends the container; its restart policy brings both back.
 */
export const GATEWAY_SCRIPT = String.raw`#!/bin/sh
set -eu
umask 077
: > /tmp/filter
for host in $(printf '%s' "$FRM_EGRESS_ALLOW" | tr ',' ' '); do
  printf '^%s$\n' "$(printf '%s' "$host" | sed 's/[.]/\\./g')" >> /tmp/filter
done
cat > /tmp/tinyproxy.conf <<EOF
Port $FRM_PROXY_PORT
Listen 0.0.0.0
Timeout 600
MaxClients 64
LogLevel Notice
DisableViaHeader Yes
FilterDefaultDeny Yes
FilterType ere
Filter "/tmp/filter"
ConnectPort 443
EOF
tinyproxy -d -c /tmp/tinyproxy.conf &
proxy=$!
node /opt/frm/mcp-relay.mjs &
relay=$!
while kill -0 "$proxy" 2>/dev/null && kill -0 "$relay" 2>/dev/null; do sleep 5; done
exit 1
`;

export interface ImageSpec {
  readonly executorId: string;
  /** The base image's id on the docker host, resolved from `base_image`. */
  readonly baseId: string;
  /** Every runner's `containerInstall` lines, in a stable order. */
  readonly installs: readonly string[];
  readonly shim: Buffer;
  /** The gateway's /mcp relay (mcp-relay.mjs). */
  readonly relay: Buffer;
}

/**
 * What every build step of executor `id` names in its command: the LABEL line holds it, and each RUN
 * is prefixed `: <marker> &&` (a no-op). A builder's container or committed image that holds it
 * came from this executor's build, labelled or not.
 */
export function buildMarker(executorId: string): string {
  return `frm.executor=${executorId}`;
}

export interface ImageContext {
  readonly dockerfile: string;
  readonly tar: Buffer;
  /** sha256 of the tar: the render hash. */
  readonly hash: string;
  /** `frm-<executor id>:<hash[0..12]>`. */
  readonly tag: string;
}

export function renderImage(spec: ImageSpec): ImageContext {
  const repository = `frm-${spec.executorId}`;
  if (!EXECUTOR_ID.test(spec.executorId) || !REPOSITORY.test(repository)) {
    throw frmError(
      "validation",
      `executor id ${JSON.stringify(spec.executorId)} makes no docker repository name`,
    );
  }
  if (!IMAGE_ID.test(spec.baseId)) {
    throw frmError(
      "validation",
      `the base must be an image id, not ${JSON.stringify(spec.baseId)}`,
    );
  }
  const bad = spec.installs.find((line) => !INSTALL.test(line));
  if (bad !== undefined) {
    throw frmError(
      "validation",
      `a containerInstall line must be one shell line: ${JSON.stringify(bad)}`,
    );
  }
  const run = `RUN : ${buildMarker(spec.executorId)} &&`;
  const dockerfile = [
    `# Rendered by \`frm executor image\`: the runner-neutral image of ${spec.executorId}.`,
    `FROM ${spec.baseId}`,
    `LABEL frm.managed=1 frm.executor=${spec.executorId}`,
    `${run} apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES} && rm -rf /var/lib/apt/lists/*`,
    ...spec.installs.map((line) => `${run} ${line}`),
    "COPY exec-shim.mjs gateway.sh mcp-relay.mjs /opt/frm/",
    "",
  ].join("\n");
  const tar = tarball([
    { name: "Dockerfile", mode: 0o644, content: Buffer.from(dockerfile) },
    { name: "exec-shim.mjs", mode: 0o644, content: spec.shim },
    { name: "gateway.sh", mode: 0o755, content: Buffer.from(GATEWAY_SCRIPT) },
    { name: "mcp-relay.mjs", mode: 0o644, content: spec.relay },
  ]);
  const hash = createHash("sha256").update(tar).digest("hex");
  return { dockerfile, tar, hash, tag: `${repository}:${hash.slice(0, 12)}` };
}

export interface ImageInfo {
  readonly id: string;
  readonly sizeBytes: number;
  /** Carries frm.managed=1 and this executor's id. */
  readonly ours: boolean;
}

/** `docker image inspect` output from `PlumbingScripts.imageInfo`, or null when absent. */
export function parseImageInfo(ran: Ran, executorId: string): ImageInfo | null {
  if (ran.code !== 0) return null;
  const [id = "", size = "", labels = ""] = ran.stdout.trim().split(" ");
  if (!IMAGE_ID.test(id)) return null;
  return {
    id,
    sizeBytes: Number(size) || 0,
    ours: labels === `1|${executorId}`,
  };
}

export interface BuiltImage extends ImageInfo {
  readonly tag: string;
  readonly hash: string;
  /** False when that tag was already on the host (same render hash): nothing was built. */
  readonly built: boolean;
  /** The image's own git, as `git --version` reports it. Checked against the submodule
   * floor here, and printed so an operator can see what a base gave them. */
  readonly gitVersion: string;
}

export interface BuildDeps {
  readonly executorId: string;
  readonly scripts: PlumbingScripts;
  readonly run: (command: string, what: string, input?: Buffer) => Promise<Ran>;
  readonly baseImage: string;
  readonly installs: readonly string[];
  readonly shim: Buffer;
  readonly relay: Buffer;
  /** The releases that clear the submodule floor (§3.6) — `workspace.git_patched`, or core's
   * `DEFAULT_GIT_PATCHED`. The caller passes the setting so the build and a spawn judge alike. */
  readonly gitPatched: readonly string[];
}

/** Resolves the base to its id (read-only), renders, and builds unless that tag is ours already. */
export async function buildImage(d: BuildDeps): Promise<BuiltImage> {
  const base = parseImageInfo(
    await d.run(d.scripts.imageInfo(d.baseImage), "inspect the base image"),
    d.executorId,
  );
  if (base === null) {
    throw frmError(
      "validation",
      `the base image ${d.baseImage} is not on the docker host; it is never pulled`,
    );
  }
  const ctx = renderImage({
    executorId: d.executorId,
    baseId: base.id,
    installs: d.installs,
    shim: d.shim,
    relay: d.relay,
  });
  const existing = await inspectOurs(d, ctx.tag);
  if (existing !== null) {
    return {
      ...existing,
      tag: ctx.tag,
      hash: ctx.hash,
      built: false,
      gitVersion: await checkedGitVersion(d, ctx.tag),
    };
  }
  const ran = await d.run(
    d.scripts.build(ctx.tag, ctx.hash),
    `build ${ctx.tag}`,
    ctx.tar,
  );
  if (ran.code !== 0) {
    throw frmError(
      "spawn_failed",
      `docker build of ${ctx.tag} failed: ${(ran.stdout + ran.stderr).trim().slice(-1500)}`,
    );
  }
  const built = await inspectOurs(d, ctx.tag);
  if (built === null) {
    throw frmError("internal", `${ctx.tag} is missing after its build`);
  }
  return {
    ...built,
    tag: ctx.tag,
    hash: ctx.hash,
    built: true,
    gitVersion: await checkedGitVersion(d, ctx.tag),
  };
}

/**
 * The image's git, refused here when it cannot run a submodule workspace. Checking at
 * build time is the point: the same floor refuses at spawn, but by then the operator has an image
 * recorded against the executor and a failure that names a session rather than the base it came
 * from. Bookworm is the case this exists for — its git reports 2.39.5 with the CVE-2025-48384 fix
 * backported under that number, indistinguishable from an unpatched 2.39.5, so it is refused.
 */
async function checkedGitVersion(d: BuildDeps, tag: string): Promise<string> {
  const ran = await d.run(
    d.scripts.imageGitVersion(tag),
    `read git's version in ${tag}`,
  );
  if (ran.code !== 0) {
    throw frmError(
      "validation",
      `cannot read git's version in ${tag}: ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
    );
  }
  const version = parseGitVersion(ran.stdout);
  if (version === null) {
    throw frmError(
      "validation",
      `cannot read git's version in ${tag} from ${JSON.stringify(ran.stdout.trim().slice(0, 80))}`,
    );
  }
  const problem = gitVersionProblem(version, d.gitPatched);
  if (problem !== null) {
    throw frmError(
      "validation",
      `${tag} was built from ${d.baseImage}, whose ${problem}. A submodule workspace cannot run on it: build from a base whose git clears the floor.`,
    );
  }
  return version;
}

async function inspectOurs(
  d: BuildDeps,
  tag: string,
): Promise<ImageInfo | null> {
  const info = parseImageInfo(
    await d.run(d.scripts.imageInfo(tag), `inspect ${tag}`),
    d.executorId,
  );
  if (info !== null && !info.ours) {
    throw frmError(
      "validation",
      `${tag} exists on the docker host without this executor's labels; not touching it`,
    );
  }
  return info;
}
