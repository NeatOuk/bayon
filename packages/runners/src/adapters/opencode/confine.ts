// Where opencode may run, and inside what. Its
// permission rules gate a tool call's text, not what the call does, so it runs only inside a real
// boundary: a Seatbelt sandbox on a local macOS executor, or a container, which is its own boundary.
// A local executor without Seatbelt (Linux) is refused: untrusted work there belongs on a container.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  err,
  ok,
  writesGit,
  type CommandPolicy,
  type Result,
} from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { SpawnSpec } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { gitWritableRoots } from "../../git-roots.js";
import { baseUrlOf, type ProviderBlock } from "./home.js";
import { RUNNER_ID } from "./registration.js";
import { hostDirOf } from "./tool-groups.js";
import {
  SANDBOX_EXEC,
  byName,
  credentialStores,
  gitGuards,
  portOf,
  seatbeltProfile,
} from "./sandbox.js";

/** A path as Seatbelt sees it: resolved, or its nearest existing parent resolved. */
function real(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}

/** Why opencode may not run on an executor of `kind` here, or null when it may. */
export function placementRefusal(
  kind: string,
  unsandboxed: boolean,
): ReturnType<typeof frmError> | null {
  if (kind === "container") return null;
  if (kind === "local" && (process.platform === "darwin" || unsandboxed)) {
    return null;
  }
  return frmError(
    "validation",
    `${RUNNER_ID} runs only inside a boundary: a Seatbelt sandbox on a macOS local executor, or a container (its permissions gate a tool call's text, not what the call does)`,
  );
}

/**
 * The argv prefix that confines opencode on `ex`: sandbox-exec and its profile, or nothing where
 * the executor is the boundary. `unsandboxed` is for tests on hosts without Seatbelt only.
 */
export async function confinement(
  ex: Executor,
  spec: SpawnSpec,
  policy: CommandPolicy | undefined,
  block: ProviderBlock,
  unsandboxed: boolean,
  /** The session's context proxy port (spec M12): it replaces the provider's, and DNS goes too. */
  proxyPort?: number,
): Promise<Result<readonly string[]>> {
  const refused = placementRefusal(ex.kind, unsandboxed);
  if (refused !== null) return err(refused);
  if (ex.kind === "container" || process.platform !== "darwin") return ok([]);
  const commits = policy === undefined || writesGit(policy);
  const roots = commits
    ? await gitWritableRoots(ex, spec.cwd, spec.env["PATH"] ?? "")
    : ok([] as readonly string[]);
  if (!roots.ok) return roots;
  const [gitDir, objects] = roots.value;
  const common = objects === undefined ? undefined : dirname(objects);
  const url = proxyPort === undefined ? baseUrlOf(block, spec.env) : undefined;
  const port = url === undefined ? undefined : portOf(url);
  const profile = seatbeltProfile({
    writable: [
      spec.cwd,
      spec.homeDir,
      ...roots.value,
      ...(common === undefined
        ? []
        : [join(common, "packed-refs"), join(common, "packed-refs.lock")]),
    ].map(real),
    denyWrite: [
      ...gitGuards(
        [
          join(spec.cwd, ".git"),
          ...(common === undefined ? [] : [common]),
          ...(gitDir === undefined ? [] : [gitDir]),
        ].map(real),
      ),
      // The host's own bookkeeping (tool-groups.ts): never the model's to write or read.
      real(hostDirOf(spec.homeDir)),
    ],
    denyRead: [...credentialStores(), real(hostDirOf(spec.homeDir))],
    providerPorts: port === undefined ? [] : [port],
    dns: url !== undefined && byName(url),
    ...(proxyPort === undefined ? {} : { loopbackPorts: [proxyPort] }),
  });
  return ok([SANDBOX_EXEC, "-p", profile]);
}
