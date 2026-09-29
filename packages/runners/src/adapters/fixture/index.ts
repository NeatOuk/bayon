// `@bayon/runners/fixture`: the runtime entry the supervisor loads for `--runner fixture`.
export {
  FIXTURE_CAPS,
  FIXTURE_COMMAND,
  FIXTURE_PROGRAM,
  FIXTURE_RUNNER_ID,
  FIXTURE_VERSION,
  createFixtureAdapter,
  fixtureCommand,
  type FixtureAdapter,
  type FixtureAdapterOptions,
} from "./adapter.js";
export {
  FIXTURE_BUNDLE,
  FIXTURE_IMAGE_COMMAND,
  FIXTURE_IMAGE_PROGRAM,
  fixtureContainerDefaults,
  installLines,
} from "./container.js";
export { fixtureProgram } from "./fake-program.js";
export { createFixtureMapper } from "./mapper.js";
export {
  DEFAULT_SCRIPT,
  FIXTURE_MCP_TOKEN_ENV,
  FixtureRun,
  FixtureScript,
  McpStep,
  STATE_FILE,
  type FixtureFetch,
  type FixtureScriptInput,
} from "./program.js";
