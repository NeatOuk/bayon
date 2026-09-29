// @bayon/db/operator: what an operator tool (tools/frm) runs against a fresh FRM_HOME: the
// migrations (as `migrate:up` does) and the config tables. apps/* must not import it (no-sql.test.ts).
export { migrateUp } from "./migrate.js";
export type { ConfigRows } from "./repos/operator.js";
export { seedConfig, setExecutorConfig } from "./repos/operator.js";
// `frm config apply`'s models: the operator's own rows, through seedConfig.
export type { OperatorModel } from "./repos/operator-models.js";
// `frm backup` and `frm restore`: the same backup the supervisor takes nightly, its row
// through the operator's own writer, and the restore.
export type { WriteBackupOptions, WrittenBackup } from "./backup/backup.js";
export { writeBackup } from "./backup/backup.js";
export { recordOperatorBackup } from "./repos/backups.js";
export type { Restored, RestoreOptions } from "./backup/restore.js";
export { restoreBackup } from "./backup/restore.js";
// `frm pause|resume` when the API does not answer: the API's own write, audited as the
// operator's with via 'frm'.
export type { FleetPauseChange } from "./repos/fleet-control.js";
export { setFleetPausedFromCli } from "./repos/fleet-control.js";
// `frm executor disable|enable`: executors.enabled, the kill switch admission honours,
// audited as the operator's with via 'frm'. Certifications and probes are untouched.
export type { ExecutorEnabledChange } from "./repos/executor-enabled.js";
export { setExecutorEnabledFromCli } from "./repos/executor-enabled.js";
// `frm settings set`: one governed setting — the GUI's whitelist and the shell-only
// security controls — checked as PUT /settings checks it, audited with via 'frm'.
export type { SettingWrite } from "./repos/setting-set.js";
export { setSettingFromCli } from "./repos/setting-set.js";
// `frm agent set`: an existing agent's profile, enabled and max_concurrency, audited.
export type {
  AgentChange,
  AgentFields,
  AgentPatch,
} from "./repos/agent-set.js";
export { setAgentFromCli } from "./repos/agent-set.js";
