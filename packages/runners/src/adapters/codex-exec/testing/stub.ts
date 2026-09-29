// Where the stand-in Codex CLI lives, for the registry's stub adapter (other packages' tests reach
// it through `@bayon/runners/testing` without naming a runner, Invariant 1). It is plain JS kept in
// src/ and never compiled, so dist/ has no copy: both builds point at the source file, which sits
// at the same depth under the package (a smoke runs this from dist/).
import { fileURLToPath } from "node:url";

export const STUB_CODEX = fileURLToPath(
  new URL(
    "../../../../src/adapters/codex-exec/testing/stub-codex.mjs",
    import.meta.url,
  ),
);
