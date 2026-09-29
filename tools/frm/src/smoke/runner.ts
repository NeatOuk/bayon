import { err, ok, type Result } from "@bayon/core";
import { OWNER_KEYCHAIN_SERVICE } from "@bayon/executors";
import { registrations, type Registration } from "@bayon/runners";
import { FIXTURE_RUNNER_ID } from "@bayon/runners/fixture";
import { z } from "zod";

// `--runner` names a kind of runner, never a runner (Invariant 1): `sdk` is the registered
// `llm_sdk` adapter, and the secrets it needs, and how to get each, come from its own
// registration defaults.

const Defaults = z.looseObject({
  secretEnv: z.array(z.string()).default([]),
  secretEnvAnyOf: z.array(z.array(z.string()).min(1)).default([]),
  secretHints: z.record(z.string(), z.string()).default({}),
});
type Defaults = z.infer<typeof Defaults>;
type Env = Readonly<Record<string, string | undefined>>;

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

const has = (env: Env, name: string): boolean =>
  Boolean(env[`FRM_SECRET_${name}`]);

/** Why this environment lacks the runner's secrets; undefined once it has them. */
function missingSecrets(d: Defaults, env: Env): string | undefined {
  const missing = d.secretEnv.filter((name) => !has(env, name));
  if (missing.length > 0) {
    return (
      `--runner sdk needs ${missing.join(", ")} from the secret store: ` +
      missing.map((name) => `set FRM_SECRET_${name}`).join(", ")
    );
  }
  const anyOf = d.secretEnvAnyOf;
  if (anyOf.length === 0) return undefined;
  if (anyOf.some((names) => names.every((name) => has(env, name)))) {
    return undefined;
  }
  const hint = (name: string): string => {
    const text = d.secretHints[name];
    return text === undefined ? "" : `: ${text}`;
  };
  return [
    `--runner sdk needs one of ${anyOf.map((names) => names.join(" + ")).join(" | ")} from the secret store, first match wins`,
    ...anyOf.flat().map((name) => `  set FRM_SECRET_${name}${hint(name)}`),
    `  keep it in the Keychain: security add-generic-password -s ${OWNER_KEYCHAIN_SERVICE} -a <NAME> -w`,
    `  then: export FRM_SECRET_<NAME>="$(security find-generic-password -s ${OWNER_KEYCHAIN_SERVICE} -a <NAME> -w)"`,
  ].join("\n");
}

/** The runner id for `choice`, once this environment may and can run it. */
export function chooseRunner(
  choice: "fixture" | "sdk",
  env: Env,
  regs: readonly Registration[] = registrations(),
): Result<string> {
  if (choice === "fixture") return ok(FIXTURE_RUNNER_ID);
  const sdk = regs.find((r) => r.runner.kind === "llm_sdk");
  if (sdk === undefined)
    return refuse("--runner sdk: no llm_sdk runner is registered");
  if (env.FRM_REAL_RUNNER !== "1")
    return refuse(
      "--runner sdk runs a real model and spends real money: set FRM_REAL_RUNNER=1 to allow it",
    );
  const defaults = Defaults.safeParse(sdk.runner.defaults);
  if (!defaults.success) {
    return refuse(
      `--runner sdk: ${sdk.runner.id} defaults: ${z.prettifyError(defaults.error)}`,
    );
  }
  const missing = missingSecrets(defaults.data, env);
  return missing === undefined ? ok(sdk.runner.id) : refuse(missing);
}
