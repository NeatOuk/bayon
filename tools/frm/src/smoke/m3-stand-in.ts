import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { registrations } from "@bayon/runners";
import {
  STUB_RUNNER_IDS,
  loadStubAdapter,
  stubCli,
  type StubCli,
} from "@bayon/runners/testing";
import { z } from "zod";

// The reviewer code_review needs (outputSchema) with no key and no network: the
// runner whose stand-in CLI declares it, found by its caps, never by name (Invariant 1). A shim
// named after that CLI goes first on the supervisor's PATH, so the daemon's own adapter drives the
// stand-in; the secrets its defaults name are placeholders in FRM_SECRET_<NAME>, so the host's
// secret store is never read for them.

export interface StandIn {
  readonly runnerId: string;
  readonly cli: StubCli;
  /** The secret names a spawn of this runner resolves. */
  readonly secrets: readonly string[];
}

/** Not a secret: the stand-in records only its digest. */
export const PLACEHOLDER_SECRET = "frm-smoke-placeholder";

const Defaults = z.looseObject({
  secretEnv: z.array(z.string().min(1)).default([]),
  secretEnvAnyOf: z.array(z.array(z.string().min(1)).min(1)).default([]),
});

const PROGRAM = /^[A-Za-z0-9._-]+$/;

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** Every secretEnv name, and the first name of each any-of group (the one a spawn tries first). */
export function secretNames(defaults: unknown): Result<string[]> {
  const d = Defaults.safeParse(defaults);
  if (!d.success) return refuse(`defaults: ${z.prettifyError(d.error)}`);
  const firsts = d.data.secretEnvAnyOf.flatMap((group) => group.slice(0, 1));
  return ok([...new Set([...d.data.secretEnv, ...firsts])]);
}

/** The runner whose stand-in declares outputSchema and runs from PATH. */
export function schemaStandIn(): Result<StandIn> {
  for (const id of STUB_RUNNER_IDS) {
    const adapter = loadStubAdapter(id);
    const cli = stubCli(id);
    if (!adapter.ok || !cli.ok || !adapter.value.caps().outputSchema) continue;
    if (!PROGRAM.test(cli.value.program))
      return refuse(`${id}'s CLI name ${cli.value.program} is not a file name`);
    const reg = registrations().find((r) => r.runner.id === id);
    const secrets = secretNames(reg?.runner.defaults);
    if (!secrets.ok) return secrets;
    return ok({ runnerId: id, cli: cli.value, secrets: secrets.value });
  }
  return err({
    class: "not_found",
    message:
      "no runner's stand-in CLI declares outputSchema: code_review would have no reviewer",
    retryable: false,
  });
}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/** A POSIX sh shim that execs `argv` with every argument it was given. */
export const shimScript = (argv: readonly string[]): string =>
  `#!/bin/sh\nexec ${argv.map(quote).join(" ")} "$@"\n`;

/**
 * Writes the shim under `home` and returns the supervisor's extra env: PATH with the shim's
 * directory first, then `path`, and each secret as a placeholder.
 */
export function standInEnv(
  home: string,
  s: StandIn,
  path: string,
  /** The value each secret gets: a placeholder, or the container run's canary. */
  secret: string = PLACEHOLDER_SECRET,
): Result<Record<string, string>> {
  const bin = join(home, "stand-in", "bin");
  const file = join(bin, s.cli.program);
  try {
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    writeFileSync(file, shimScript(s.cli.argv), { mode: 0o755 });
    chmodSync(file, 0o755);
  } catch (cause) {
    return err({
      class: "internal",
      message: `cannot write the stand-in shim ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      retryable: false,
    });
  }
  return ok({
    PATH: path === "" ? bin : `${bin}${delimiter}${path}`,
    ...Object.fromEntries(
      s.secrets.map((name) => [`FRM_SECRET_${name}`, secret]),
    ),
  });
}
