// Where the stand-in opencode lives, for the registry's stub adapter (other packages' tests reach it
// through `@bayon/runners/testing` without naming a runner, Invariant 1). It is plain JS kept in
// src/ and never compiled, so dist/ has no copy: both builds point at the source file, which sits
// at the same depth under the package.
import { fileURLToPath } from "node:url";

export const STUB_OPENCODE = fileURLToPath(
  new URL(
    "../../../../src/adapters/opencode/testing/stub-opencode.mjs",
    import.meta.url,
  ),
);
