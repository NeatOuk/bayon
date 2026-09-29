// The fixture in a container executor's image. `pnpm -w build` bundles the compiled
// program with its one dependency (zod) into one ESM file, FIXTURE_BUNDLE; the adapter's own
// `containerInstall` lines write it into the runner-neutral image, gzipped and base64-encoded in
// chunks, and fail the build unless its sha256 matches. Nothing else of the repo enters the image.
// A session placed in a container runs it with the image's node (FIXTURE_IMAGE_COMMAND).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { Argv } from "@bayon/executors";
import { frmError } from "../../errors.js";

/** Where the image holds the program. */
export const FIXTURE_IMAGE_PROGRAM = "/opt/frm/runners/fixture/program.mjs";
/** The image's node, found on the session's PATH (the image's), running the image's program. */
export const FIXTURE_IMAGE_COMMAND: Argv = ["node", FIXTURE_IMAGE_PROGRAM];
/** What the build writes: the same file from src/ and from dist/, both three levels down. */
export const FIXTURE_BUNDLE = fileURLToPath(
  new URL("../../../dist/adapters/fixture/program.bundle.mjs", import.meta.url),
);
/** Base64 characters per install line, so a Dockerfile line stays under BuildKit's 64 KiB. */
export const INSTALL_CHUNK = 48_000;

/** A path the lines may name unquoted: absolute, normalized, no shell metacharacter. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * The image lines that write `bundle` to `target`; the build fails unless the bytes match.
 * `target` rides the lines unquoted, so anything but a plain absolute path is refused.
 */
export function installLines(
  bundle: Uint8Array,
  target: string = FIXTURE_IMAGE_PROGRAM,
): readonly string[] {
  if (!PLAIN_PATH.test(target) || posix.normalize(target) !== target) {
    throw frmError(
      "validation",
      `an install target must be a plain absolute path: ${JSON.stringify(target)}`,
    );
  }
  const staged = `${target}.gz.b64`;
  const encoded = gzipSync(bundle, { level: 9 }).toString("base64");
  const chunks = Array.from(
    { length: Math.ceil(encoded.length / INSTALL_CHUNK) },
    (_, i) => encoded.slice(i * INSTALL_CHUNK, (i + 1) * INSTALL_CHUNK),
  );
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  return [
    `mkdir -p ${posix.dirname(target)} && rm -f ${staged}`,
    ...chunks.map((chunk) => `printf %s ${chunk} >> ${staged}`),
    `base64 -d < ${staged} | gunzip > ${target} && rm ${staged} && echo '${sha256}  ${target}' | sha256sum -c -`,
  ];
}

/** The fixture's container facts: its install lines, or why it cannot run in a container. */
export type FixtureContainerDefaults =
  | { readonly containerInstall: readonly string[] }
  | { readonly containerUnready: string };

/** From the built bundle; without one, the fixture says it is not container-ready and why. */
export function fixtureContainerDefaults(
  read: () => Uint8Array = () => readFileSync(FIXTURE_BUNDLE),
): FixtureContainerDefaults {
  try {
    return { containerInstall: installLines(read()) };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return {
      containerUnready: `its program bundle is not built (run pnpm -w build): ${why}`,
    };
  }
}
