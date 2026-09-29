// `@bayon/runners`: the runner contract (contract 4) and the adapter registry. Adapter-specific
// code stays in src/adapters/<id>/ (Invariant 1); callers load adapters by runner id.
export type {
  ExitInfo,
  Fetch,
  HealthPlace,
  MapInput,
  MappedEvent,
  Mapper,
  ModelPreflight,
  ModelRow,
  ModelTier,
  PreflightTarget,
  RawRecord,
  Registration,
  RunnerAdapter,
  RunnerKind,
  RunnerUpdate,
  SendSpec,
  SessionHandle,
  SpawnSpec,
} from "./adapter.js";
export { RUNNER_IDS, loadAdapter, registrations } from "./adapters/registry.js";
export { applyPrepared } from "./prepared.js";
export { PREFLIGHT_TIMEOUT_MS, preflightModel } from "./preflight.js";
export { UNPARSED } from "./record-events.js";
export { RECORDS_HIGH_WATER } from "./records.js";
export type { ByModel, CostSource, Spend, Totals } from "./spend.js";
export { npmLatest } from "./update-check.js";
