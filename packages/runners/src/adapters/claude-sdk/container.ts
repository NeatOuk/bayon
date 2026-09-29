// claude-sdk in a container executor's image. The SDK stays in the supervisor: it drives
// the CLI over stdin and stdout and starts it through our Executor, so the CLI
// is the one program a container runs. The adapter's own `containerInstall` lines install the npm
// package of the exact CLI version the installed SDK bundles, link its native binary at
// CLAUDE_IMAGE_CLI, and fail the image build unless that binary's sha256 is one the SDK's own
// manifest lists for Linux: a container runs the bytes the SDK would spawn here. No node runs it.
import { posix } from "node:path";
import { z } from "zod";
import { frmError } from "../../errors.js";

/** Where the image holds the CLI. A session placed in a container runs it, native, no node. */
export const CLAUDE_IMAGE_CLI = "/opt/frm/runners/claude-sdk/claude";
/** The CLI's npm package: its postinstall puts the platform's native binary over `bin/claude.exe`. */
const CLI_PACKAGE = "@anthropic-ai/claude-code";
/** The manifest's platforms an image can be: glibc or musl, x64 or arm64. */
export const LINUX_PLATFORMS = [
  "linux-x64",
  "linux-arm64",
  "linux-x64-musl",
  "linux-arm64-musl",
] as const;
/** The only host a session's CLI reaches, through the gateway's allowlist. */
export const EGRESS_HOSTS: readonly string[] = ["api.anthropic.com"];

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A path the lines may name unquoted: absolute, normalized, no shell metacharacter. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The CLI an image is pinned to: its version and the Linux binaries' sha256 checksums. */
export interface CliPin {
  readonly version: string;
  readonly checksums: readonly string[];
}

const Manifest = z.looseObject({
  version: z.string(),
  platforms: z.record(z.string(), z.unknown()),
});
const Platform = z.looseObject({ checksum: z.string().regex(SHA256) });

/** The pin from the SDK's parsed `manifest.json`, or why there is none. */
export function cliPin(manifest: unknown): CliPin | { readonly why: string } {
  const parsed = Manifest.safeParse(manifest);
  if (!parsed.success) {
    return { why: "its SDK's manifest.json is missing or has no platforms" };
  }
  const { version, platforms } = parsed.data;
  if (!SEMVER.test(version)) {
    return {
      why: `its bundled CLI version ${JSON.stringify(version)} is not x.y.z`,
    };
  }
  const checksums: string[] = [];
  for (const name of LINUX_PLATFORMS) {
    if (platforms[name] === undefined) continue;
    const platform = Platform.safeParse(platforms[name]);
    if (!platform.success) {
      return { why: `its SDK's manifest has no sha256 checksum for ${name}` };
    }
    checksums.push(platform.data.checksum);
  }
  return checksums.length === 0
    ? { why: "its SDK's manifest names no Linux CLI binary" }
    : { version, checksums };
}

/**
 * The image lines that install `pin`'s CLI and link it at `target`; the build fails unless the
 * linked binary is one of the pin's. Every value rides a shell line, so each is checked again here.
 */
export function installLines(
  pin: CliPin,
  target: string = CLAUDE_IMAGE_CLI,
): readonly string[] {
  if (!PLAIN_PATH.test(target) || posix.normalize(target) !== target) {
    throw frmError(
      "validation",
      `an install target must be a plain absolute path: ${JSON.stringify(target)}`,
    );
  }
  if (!SEMVER.test(pin.version)) {
    throw frmError(
      "validation",
      `not a CLI version: ${JSON.stringify(pin.version)}`,
    );
  }
  if (
    pin.checksums.length === 0 ||
    !pin.checksums.every((c) => SHA256.test(c))
  ) {
    throw frmError("validation", "a CLI pin needs sha256 checksums");
  }
  const cli = `claude CLI ${pin.version}`;
  return [
    `npm install -g ${CLI_PACKAGE}@${pin.version}`,
    [
      `mkdir -p ${posix.dirname(target)}`,
      `ln -sf "$(npm root -g)/${CLI_PACKAGE}/bin/claude.exe" ${target}`,
      `sum=$(sha256sum < ${target} | cut -d " " -f 1)`,
      `case "$sum" in ${pin.checksums.join("|")}) echo "${cli}: sha256 $sum";; *) echo "${cli}: sha256 $sum is not one the SDK bundles" >&2; exit 1;; esac`,
    ].join(" && "),
  ];
}

/** The runner's container facts: its image lines, or why it cannot run in a container. */
export type ClaudeContainerDefaults = {
  readonly egressHosts: readonly string[];
} & (
  | { readonly containerInstall: readonly string[] }
  | { readonly containerUnready: string }
);

/** From the SDK's parsed `manifest.json` (undefined when unreadable). */
export function claudeContainerDefaults(
  manifest: unknown,
): ClaudeContainerDefaults {
  const pin = cliPin(manifest);
  return "why" in pin
    ? {
        containerUnready: `no image can be pinned to its CLI: ${pin.why}`,
        egressHosts: EGRESS_HOSTS,
      }
    : { containerInstall: installLines(pin), egressHosts: EGRESS_HOSTS };
}
