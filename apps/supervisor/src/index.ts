// @bayon/supervisor: the process skeleton, the commands claimer and ingest (FOR-6), which the
// session lifecycle builds on.
export type {
  ClaimerOptions,
  CommandClaimer,
  CommandHandler,
  CommandMeta,
} from "./commands/claimer.js";
export { COMMAND_POLL_MS, createClaimer } from "./commands/claimer.js";
export type {
  AttachOptions,
  Attachment,
  Committed,
  Ingest,
  IngestAdapter,
  IngestOptions,
  SupervisorClose,
  TerminalNotice,
} from "./ingest/ingest.js";
export { createIngest } from "./ingest/ingest.js";
export { BATCH_MAX_DELAY_MS, BATCH_MAX_ROWS } from "./ingest/batcher.js";
export {
  dbPath,
  rawLogPath,
  sessionDir,
  socketPath,
  toolDir,
} from "./paths.js";
export type {
  Lifecycle,
  LifecycleDeps,
  LifecycleFactory,
  Supervisor,
  SupervisorOptions,
} from "./supervisor.js";
export { startSupervisor } from "./supervisor.js";
export type { BootRowsOptions } from "./boot.js";
export {
  LOCAL_EXECUTOR_ID,
  LOCAL_EXECUTOR_SLOTS,
  registrationRows,
  upsertBootRows,
} from "./boot.js";
export { SOCKET_PATH_MAX_BYTES } from "./socket.js";
export { HEARTBEAT_INTERVAL_MS } from "./heartbeat.js";
