// Where the stand-in CLI lives, for the registry's stub adapters (other packages' tests reach it
// through `@bayon/runners/testing` without naming a runner, Invariant 1).
import { fileURLToPath } from "node:url";

export const STUB_CLI = fileURLToPath(
  new URL("./stub-cli.mjs", import.meta.url),
);
