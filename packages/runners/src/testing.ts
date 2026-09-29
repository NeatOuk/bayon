// `@bayon/runners/testing`: the fixture runner for other packages' tests (8, 11). The
// same adapter is the runtime entry `@bayon/runners/fixture`; `fixtureProgram` runs it in-process
// under FakeExecutor (register it as `FIXTURE_PROGRAM`, build with `command: [FIXTURE_PROGRAM]`).
export type * from "./adapters/fixture/index.js";
export * from "./adapters/fixture/index.js";
// Stand-in CLIs for an adapter's real SDK path, by runner id.
export {
  STUB_RUNNER_IDS,
  loadStubAdapter,
  stubCli,
  type StubCli,
} from "./adapters/registry.js";
// Over-cap shell results by runner id, for ingest's runner-neutral cap test (§8.5).
export {
  TOOL_OUTPUT_SAMPLES,
  type ToolOutputSample,
} from "./adapters/registry.js";
// The deliberately non-compliant runner and the fixture's conformance kit:
// tests only, never in the registry's FACTORIES.
export {
  BROKEN_STUB_ID,
  createBrokenStubAdapter,
  type BrokenStubFlags,
} from "./adapters/broken-stub/index.js";
export { FIXTURE_KIT } from "./adapters/fixture/conformance.js";
