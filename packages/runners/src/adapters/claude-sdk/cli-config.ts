// The interactive CLI keeps its own first-run state on disk, separate from the credential the SDK
// path injects into the env — so an attach into a fresh home met the setup wizard instead of the
// session. Two gates, both interactive-only, which is why the SDK path never saw them:
// onboarding (theme, then login method) and the per-workspace trust prompt. Seeding two keys clears
// both; see the design for the reproduction and for why nothing else is needed.
//
// This is not a login. Authentication still comes from the env var the supervisor resolved at spawn;
// nothing here fakes, stores or persists a credential.
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { SpawnSpec } from "../../adapter.js";
import { asFrmError } from "../../errors.js";
import { writeHomeFile } from "./home-file.js";

/** The CLI's own config, inside `CLAUDE_CONFIG_DIR`. It owns this file; we only add to it. */
export const CLI_CONFIG_FILE = ".claude.json";
/** Where a config we could not read is kept, beside the one that replaced it. */
export const UNREADABLE_SUFFIX = ".unreadable";

const ONBOARDED = "hasCompletedOnboarding";
const PROJECTS = "projects";
const TRUSTED = "hasTrustDialogAccepted";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The content to write so an interactive start in `cwd` skips both gates, or `undefined` when
 * there is nothing to do — already seeded, or a file we do not understand.
 *
 * Pure, and deliberately additive: the CLI writes its own state here (session keys, `machineID`,
 * migrations), so everything already present is preserved byte for byte.
 *
 * `keep` and `replace` are kept apart on purpose. Both mean "the merge produced nothing to add",
 * but one is healthy and the other is a file we could not read — and a single `undefined` for both
 * would let a corrupt config silently reproduce the very wizard this exists to prevent, with
 * nothing anywhere to say why.
 */
export type CliConfigPlan =
  | { readonly action: "keep" }
  | { readonly action: "write"; readonly content: string }
  | { readonly action: "replace"; readonly content: string };

export function mergeCliConfig(
  raw: string | undefined,
  cwd: string,
): CliConfigPlan {
  const seed = (
    current: Record<string, unknown>,
  ): { readonly content: string } | undefined => {
    const projects = isObject(current[PROJECTS]) ? current[PROJECTS] : {};
    const project = isObject(projects[cwd]) ? projects[cwd] : {};
    if (current[ONBOARDED] === true && project[TRUSTED] === true)
      return undefined;
    return {
      content: JSON.stringify({
        ...current,
        [ONBOARDED]: true,
        [PROJECTS]: { ...projects, [cwd]: { ...project, [TRUSTED]: true } },
      }),
    };
  };

  if (raw === undefined) {
    const fresh = seed({});
    // A seed of an empty config always has both keys to add.
    return fresh === undefined
      ? { action: "keep" }
      : { action: "write", content: fresh.content };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!isObject(parsed)) {
    // Not a config the CLI could use either, so nothing is lost by starting one — but the old
    // bytes are kept beside it rather than dropped (see seedCliConfig).
    const fresh = seed({});
    return fresh === undefined
      ? { action: "keep" }
      : { action: "replace", content: fresh.content };
  }

  const merged = seed(parsed);
  return merged === undefined
    ? { action: "keep" }
    : { action: "write", content: merged.content };
}

/**
 * Seeds the CLI's config in the session's home for an interactive start in `spec.cwd`.
 *
 * The caller must have stopped the session's automated process first: that process is the same CLI
 * on the same `CLAUDE_CONFIG_DIR` and writes this file throughout its life, so a read-modify-write
 * beside a live one can lose either side's update (`lifecycle/attach.ts` quiesces before asking for
 * a resume, and that order is load-bearing).
 *
 * Only where the home is this host's: the read half has no remote form, and attach is local-only
 * (`lifecycle/attach.ts`). A non-local executor is left untouched rather than half-seeded — when
 * takeover grows a container arm, this branch has to grow a remote read with it, or a
 * container attach will land back in the wizard with nothing reporting why.
 */
export async function seedCliConfig(
  spec: SpawnSpec,
  ex: Executor,
): Promise<Result<void>> {
  if (ex.kind !== "local") return ok(undefined);
  const path = join(spec.homeDir, CLI_CONFIG_FILE);

  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Absent is the normal first attach. Anything else means the home is not what we think it is,
    // and writing over it blind would be worse than failing the attach.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(asFrmError(e, "spawn_failed", `cannot read ${path}`));
    }
  }

  const plan = mergeCliConfig(raw, spec.cwd);
  if (plan.action === "keep") return ok(undefined);
  if (plan.action === "replace") {
    // Evidence, not a log line this layer has no way to emit: the unusable bytes stay next to the
    // file they came from, so an operator who lands in the wizard can see what was there.
    try {
      renameSync(path, `${path}${UNREADABLE_SUFFIX}`);
    } catch (e) {
      return err(asFrmError(e, "spawn_failed", `cannot set aside ${path}`));
    }
  }
  return writeHomeFile(ex, path, plan.content);
}
