import {
  AGENT_GIT_AUTHOR_KEY,
  AgentGitAuthor,
  DEFAULT_AGENT_GIT_AUTHOR,
  DEFAULT_GIT_PATCHED,
  DEFAULT_MARGIN_PCT,
  GIT_RELEASE,
  QA_CI_GRACE_DEFAULT_MS,
  QA_CI_GRACE_KEY,
  err,
  ok,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { z } from "zod";
import { DEFAULT_COMMAND_MAX_ATTEMPTS } from "../commands/claimer.js";
import { frmError } from "./errors.js";

const ms = z.int().positive();

/** The lifecycle's tunables (config over code): `settings` rows, else these defaults. */
const Settings = z.object({
  "lifecycle.interrupt_grace_ms": ms.default(10_000),
  "lifecycle.kill_grace_ms": ms.default(5_000),
  "lifecycle.adopt_max": z.int().nonnegative().default(3),
  /** An attach lease's TTL (§12.5), renewed by the pty WS heartbeat (Ticket B). */
  "lifecycle.attach_lease_ms": ms.default(900_000),
  "reconciler.interval_ms": ms.default(60_000),
  /** The command requeue amendment: claimed longer than this, not in flight → requeued. */
  "reconciler.command_requeue_ms": ms.default(300_000),
  /** Claims one command gets before it is failed (seeded by 013). */
  "reconciler.command_max_attempts": z
    .int()
    .positive()
    .default(DEFAULT_COMMAND_MAX_ATTEMPTS),
  "executor.health_timeout_ms": ms.default(5_000),
  /** Each git command of the workspace step (§9.2), run under the per-mirror mutex: past it,
   * git is killed and the spawn fails `timeout`, so a hung fetch cannot hold the mirror. */
  "workspace.git_timeout_ms": ms.default(300_000),
  /** Design an earlier change §3.6 (M3): the upstream releases fixed for CVE-2024-32002 and CVE-2025-48384,
   * one per series. A submodule workspace needs its executor's git at or past its series' entry,
   * or newer than every entry. Upstream releases only: no per-version whitelist (N1). */
  "workspace.git_patched": z
    .array(z.string().regex(GIT_RELEASE))
    .min(1)
    .default([...DEFAULT_GIT_PATCHED]),
  /** Pre-flight (§8.4): the margin added to a prompt's token count before it meets its cap. */
  "preflight.margin_pct": z
    .number()
    .min(0)
    .max(100)
    .default(DEFAULT_MARGIN_PCT),
  /** The hand-off run (M2 amendment e): its turns, wall clock and prompt; the packet's size. */
  "handoff.max_turns": z.int().positive().default(3),
  "handoff.wall_clock_ms": ms.default(300_000),
  "handoff.prompt_tokens_cap": z.int().positive().default(1_500),
  "handoff.packet_tokens_cap": z.int().positive().default(1_200),
  /** §7.1's `budget` trigger: a hand-off at this % of the run class's cost_cap_usd. 0 = off. */
  "ceilings.handoff_at_cost_pct": z.number().min(0).max(100).default(80),
  /** How long a CI gate waits for a first check before it decides the CI is not coming (043). */
  [QA_CI_GRACE_KEY]: ms.default(QA_CI_GRACE_DEFAULT_MS),
  /** The git identity agents commit as (016): every session's GIT_AUTHOR_* and
   * GIT_COMMITTER_*. `Name <email>`, parsed; the default is parsed the same way (prefault). */
  [AGENT_GIT_AUTHOR_KEY]: AgentGitAuthor.prefault(DEFAULT_AGENT_GIT_AUTHOR),
});
export type LifecycleSettings = z.infer<typeof Settings>;

/** Every tunable at its default: what the lifecycle uses until boot loads the rows. */
export const DEFAULT_SETTINGS: LifecycleSettings = Settings.parse({});

const KEYS = Object.keys(Settings.shape);

export async function loadSettings(db: Db): Promise<Result<LifecycleSettings>> {
  const rows = await getSettings(db, KEYS);
  if (!rows.ok) return rows;
  const parsed = Settings.safeParse(Object.fromEntries(rows.value));
  return parsed.success
    ? ok(parsed.data)
    : err(
        frmError(
          "validation",
          `lifecycle settings: ${z.prettifyError(parsed.error)}`,
        ),
      );
}
