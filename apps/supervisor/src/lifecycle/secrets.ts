import { LOGIN_IN_PLACE_KEY, err, ok, type Result } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import { frmError } from "./errors.js";

// The host secret store (§14) lives in @bayon/executors, so tools/frm reads the backup key the
// same way the supervisor reads every secret. Values go into a child's env at spawn.
export {
  envSecrets,
  firstOf,
  keychainSecrets,
  type SecretStore,
} from "@bayon/executors";

type Resolved = readonly (readonly [string, string])[];

/** Every name from the store, or the first miss. */
async function getAll(
  store: SecretStore,
  names: readonly string[],
): Promise<Result<Resolved>> {
  const found: (readonly [string, string])[] = [];
  for (const name of names) {
    const value = await store.get(name);
    if (!value.ok) return value;
    found.push([name, value.value]);
  }
  return ok(found);
}

/**
 * The secrets a spawn injects: every `required` name, then the first alternative of `anyOf` whose
 * names are all in the store, in declared order. Only that alternative is returned, so a runner
 * never gets two competing credentials. A miss names the secrets, never a value.
 */
export async function resolveSecrets(
  store: SecretStore,
  required: readonly string[],
  anyOf: readonly (readonly string[])[],
): Promise<Result<Resolved>> {
  const always = await getAll(store, required);
  if (!always.ok || anyOf.length === 0) return always;
  for (const alternative of anyOf) {
    const chosen = await getAll(store, alternative);
    if (chosen.ok) return ok([...always.value, ...chosen.value]);
  }
  const names = anyOf.map((alternative) => alternative.join(" + ")).join(" | ");
  // The other door, named because a copy of a rotating login is the thing that goes stale here: a
  // credential the runner's own CLI already holds on this host may be used in place, with consent
  // (§14). The message says so, since "no secret" and "a secret five days old" look alike from the
  // outside and the second one only shows up as a dead token mid-turn.
  return err(
    frmError(
      "validation",
      `none of the secrets ${names} is in the secret store; if this runner's CLI is already logged in on this host, consent to using that login in place with \`frm settings set ${LOGIN_IN_PLACE_KEY} <runner-id>=<path> --yes\` (§14)`,
    ),
  );
}
