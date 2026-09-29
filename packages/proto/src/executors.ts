import { z } from "zod";

// Executors (§6, §6.1): `GET /executors` shows each row as the supervisor keeps it, with
// its last health check's measurements parsed; `POST /executors/:id/health` inserts one
// `executor.health` command, which the supervisor runs and records.

const Json = z.json();

export const ExecutorView = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  trust: z.string().min(1),
  egress_policy: z.string().min(1),
  slots: z.int().nonnegative(),
  enabled: z.boolean(),
  health: z.string().min(1),
  health_checked_at: z.int().nullable(),
  /** What the last health check measured (`health_detail`), or null. */
  health_detail: Json.nullable(),
  /** `config_json`: hosts, paths and limits, never a secret (§14). Null when unreadable. */
  config: Json.nullable(),
});
export type ExecutorView = z.infer<typeof ExecutorView>;

export const ExecutorsView = z.object({
  executors: z.array(ExecutorView),
  /**
   * The `executors.untrusted_roles` setting (trust rule, M3): the roles that need a
   * trust='untrusted' executor. Null when the setting is missing or not a list of roles.
   */
  untrusted_roles: z.array(z.string().min(1)).nullable(),
});
export type ExecutorsView = z.infer<typeof ExecutorsView>;

/** `POST /executors/:id/health`'s reply (202): the `executor.health` command. */
export const ExecutorHealthAccepted = z.object({
  command_id: z.string().min(1),
  created: z.boolean(),
});
export type ExecutorHealthAccepted = z.infer<typeof ExecutorHealthAccepted>;

/**
 * `POST /executors` (§9.5 amendment): what `frm executor add` takes, minus
 * `--untrusted-roles` (a global policy edit, out of scope for adding one executor — stays the
 * CLI's alone). Loose on purpose: the real strictness (the id's shape, host/port/user/identity_ref/
 * remote_root/network/egress host/image ref regexes and bounds) is `ContainerExecutorConfig`'s
 * (`@bayon/executors`), re-checked in the service — `packages/proto` cannot import that package
 * (no dependency edge), so this schema is not where the wire contract's real strictness lives.
 */
export const CreateExecutorRequest = z.strictObject({
  id: z.string().min(1).max(32),
  host: z.string().min(1).max(253),
  port: z.int().min(1).max(65_535).optional(),
  user: z.string().min(1).max(32),
  /** `file:<private key path, 0600>` or `agent:<public key path>`; never the key itself (§6.1). */
  identity_ref: z.string().min(1),
  remote_root: z.string().min(1),
  slots: z.int().min(1).max(64).default(2),
  network: z.string().min(1).max(64).optional(),
  /** Comma-free: one host per array entry, unlike the CLI's `--egress-allow a,b`. */
  egress_allow: z.array(z.string().min(1)).optional(),
  base_image: z.string().min(1).optional(),
  min_free_pct: z.number().min(0).max(100).optional(),
  quota_gb: z.number().positive().optional(),
});
export type CreateExecutorRequest = z.infer<typeof CreateExecutorRequest>;

/** `POST /executors`'s reply (201). */
export const ExecutorCreated = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  known_hosts_entries_copied: z.int().nonnegative(),
});
export type ExecutorCreated = z.infer<typeof ExecutorCreated>;
