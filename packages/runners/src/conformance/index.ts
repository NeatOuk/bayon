// `@bayon/runners/conformance`: the §15 suite. an earlier change runs it through the
// supervisor's ports and stores core `certify`'s result per (runner, executor); adapters ship
// their kits in `adapters/<id>/conformance.ts`, loaded by runner id with `conformanceKit`.
export { conformanceKit } from "../adapters/registry.js";
export {
  FaultExecutor,
  type ArmedFault,
  type FaultOptions,
} from "./fault-executor.js";
export { ECHO_TOOL, referenceMcpProbe, startMcpProbe } from "./mcp-probe.js";
export { createMemoryIngest } from "./memory-ingest.js";
export { createReferencePorts } from "./reference.js";
export { renderReport, reportFileName, type ExecutorFacts } from "./report.js";
export { kitHash, runConformance } from "./suite.js";
export {
  LIVE_BUDGETS,
  OFFLINE_BUDGETS,
  SCENARIO_NAMES,
  SUITE_PEAK_SESSIONS,
  type AttachSpec,
  type Budgets,
  type Check,
  type ConformanceKit,
  type ConformanceOptions,
  type ConformancePorts,
  type ConformanceSubject,
  type EventSource,
  type FileDiff,
  type IngestPort,
  type McpProbe,
  type McpProbeCall,
  type McpProbePort,
  type RunClose,
  type Scenario,
  type ScenarioName,
  type ScenarioVars,
  type SessionDirs,
  type StoredEvent,
  type WatchdogPort,
  type WatchResult,
  type WatchSpec,
  type WorkspacePort,
} from "./types.js";
export {
  createReferenceWatchdog,
  untilElapsed,
  type ReferenceWatchdogOptions,
} from "./watchdog.js";
export {
  FIXTURE_FILES,
  createLocalWorkspace,
  parseDiff,
  safeName,
} from "./workspace.js";
