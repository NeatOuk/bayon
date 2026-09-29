import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

// Every node-side test file, and every process a test spawns with this environment, finds the
// stand-in `security` (test-bin/security) before the real one: the test suite can never
// read the operator's Keychain, whatever FRM_HOME a test gives its supervisor or API.
const TEST_BIN = fileURLToPath(new URL("./test-bin", import.meta.url));

const path = process.env.PATH ?? "";
if (path.split(delimiter)[0] !== TEST_BIN) {
  process.env.PATH = `${TEST_BIN}${delimiter}${path}`;
}

// No test, and no frm a test spawns, may fall back to the operator's default home (~/.foreman):
// tools/frm/src/home.ts refuses the default while this is set.
process.env.FRM_NO_DEFAULT_HOME = "1";
