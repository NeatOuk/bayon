// §9.6 step 7 and §6.1. Every executor runs its own check (Executor.health):
// disk, clock skew and, for a container, docker and its plumbing, judged against the fleet's
// limits, read from settings on every check (executor.clock_skew_max_ms,
// admission.disk_min_free_pct). A row's optional config_json.healthArgv runs after it as one more
// check. Each pass first hands the executor its row as the DB now holds it, so an operator's
// `frm executor image` reaches a running supervisor. On a healthy executor the certified
// runners' versions are then re-detected, and a changed
// one decertifies its pair (conformance/redetect.ts). The detail, runner readings included, is
// recorded in executors.health_detail; unhealthy queues admission and shows in v_needs_attention.
import {
  ExecutorHealthDetail,
  HEALTH_SETTING_KEYS,
  healthLimits,
  type HealthLimits,
  type JsonValue,
  type Result,
  type RunnerReading,
} from "@bayon/core";
import {
  getSettings,
  listExecutors,
  type Db,
  type ExecutorHealth,
  type ExecutorRow,
} from "@bayon/db";
import { setExecutorHealth } from "@bayon/db/supervisor";
import type { Executor, ExecutorHealthReport } from "@bayon/executors";
import { z } from "zod";
import { redetectRunners } from "../conformance/redetect.js";
import { readText, settlesWithin } from "./async-util.js";
import type { Ctx } from "./context.js";
import { asFrmError } from "./errors.js";

const HealthConfig = z.looseObject({
  healthArgv: z.tuple([z.string().min(1)], z.string()).optional(),
});

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface Probed {
  readonly health: "healthy" | "unhealthy";
  /** What the check measured; null when it could not run or threw. */
  readonly detail: JsonValue | null;
}

/** Checks one executor and records the verdict. Unhealthy queues admission (§9.1). */
export async function checkHealth(
  ctx: Ctx,
  row: ExecutorRow,
): Promise<ExecutorHealth> {
  const { health, detail } = await probeHealth(ctx, row);
  // The boot self-check of its orphan scan rides along; it never makes it unhealthy.
  const scan = ctx.orphanScan.get(row.id);
  const recorded: JsonValue | null =
    scan === undefined
      ? detail
      : {
          ...(detail !== null &&
          typeof detail === "object" &&
          !Array.isArray(detail)
            ? detail
            : {}),
          orphan_scan: scan,
        };
  const saved = await setExecutorHealth(ctx.db, row.id, health, recorded);
  if (!saved.ok) {
    ctx.log.error(
      { executor: row.id, error: saved.error },
      "cannot record health",
    );
  }
  return health;
}

export async function checkAllHealth(ctx: Ctx): Promise<void> {
  const rows = await listExecutors(ctx.db);
  if (!rows.ok) {
    ctx.log.error({ error: rows.error }, "cannot list executors");
    return;
  }
  resizeSlots(ctx, rows.value);
  for (const row of rows.value.filter((r) => r.enabled === 1)) {
    await checkHealth(ctx, row);
  }
}

/**
 * Every loaded executor's capacity from its row: at boot and on each health
 * pass, so Fleet and admission never show a constructor's capacity. Never persisted.
 */
export function resizeSlots(ctx: Ctx, rows: readonly ExecutorRow[]): void {
  for (const row of rows) ctx.executors.get(row.id)?.slots.resize(row.slots);
}

function unhealthy(ctx: Ctx, id: string, why: string): "unhealthy" {
  ctx.log.warn({ executor: id }, `executor ${id} is unhealthy: ${why}`);
  return "unhealthy";
}

/** The fleet's health limits from settings, read on every check (the health pass, a pre-flight). */
export async function readHealthLimits(db: Db): Promise<Result<HealthLimits>> {
  const values = await getSettings(db, [...HEALTH_SETTING_KEYS]);
  return values.ok ? healthLimits(values.value) : values;
}

async function probeHealth(ctx: Ctx, row: ExecutorRow): Promise<Probed> {
  const ex = ctx.executors.get(row.id);
  if (ex === undefined) {
    return { health: unhealthy(ctx, row.id, "not loaded here"), detail: null };
  }
  // The row as it is now, not as boot read it: `frm executor image` rebuilds under a
  // running supervisor, and an executor still on its boot-time image treats the gateway that
  // rebuild started as foreign and tears it down. This is the pass that would do the tearing, so
  // the adoption happens here, before its own check runs. Null means only "the row says nothing
  // new": a row that does not parse comes back as its own line, so an operator's
  // edit the supervisor cannot take is logged rather than dropped.
  const adopted = ex.executor.reloadConfig?.(parseJson(row.config_json));
  if (adopted !== undefined && adopted !== null) {
    ctx.log.warn(
      { executor: row.id, adopted },
      `executor ${row.id} adopted its row's ${adopted}`,
    );
  }
  const limits = await readHealthLimits(ctx.db);
  if (!limits.ok) {
    return {
      health: unhealthy(ctx, row.id, limits.error.message),
      detail: null,
    };
  }
  const report = await ownCheck(ex.executor, limits.value);
  if (!report.ok) {
    return { health: unhealthy(ctx, row.id, report.why), detail: null };
  }
  const { healthy, detail } = report.value;
  const argv = healthy ? await argvFailure(ctx, row, ex.executor) : null;
  const failures = [
    ...detail.failures,
    ...(argv === null ? [] : [`healthArgv: ${argv}`]),
  ];
  if (!healthy || argv !== null) {
    const why = failures.join("; ") || "its health check failed";
    return {
      health: unhealthy(ctx, row.id, why),
      detail: { ...detail, failures },
    };
  }
  const runners = await redetectRunners(
    {
      db: ctx.db,
      clock: ctx.clock,
      log: ctx.log,
      adapters: ctx.adapters,
      timeoutMs: ctx.settings["executor.health_timeout_ms"],
    },
    ex.executor,
    previousReadings(row),
  );
  return { health: "healthy", detail: { ...detail, runners } };
}

/** The executor's own check: bounded by the executor, and a throw is only a failed check. */
async function ownCheck(
  executor: Executor,
  limits: HealthLimits,
): Promise<
  | { readonly ok: true; readonly value: ExecutorHealthReport }
  | { readonly ok: false; readonly why: string }
> {
  try {
    return { ok: true, value: await executor.health(limits) };
  } catch (e) {
    return {
      ok: false,
      why: asFrmError(e, "internal", "the health check threw").message,
    };
  }
}

/** The runner readings the last check recorded, so a pass reports only what changed. */
function previousReadings(
  row: ExecutorRow,
): Readonly<Record<string, RunnerReading>> {
  const parsed = ExecutorHealthDetail.safeParse(parseJson(row.health_detail));
  return parsed.success ? (parsed.data.runners ?? {}) : {};
}

/** The row's own extra check, when config_json names one: null when it passes or there is none. */
async function argvFailure(
  ctx: Ctx,
  row: ExecutorRow,
  executor: Executor,
): Promise<string | null> {
  const config = HealthConfig.safeParse(parseJson(row.config_json));
  if (!config.success) return "config_json.healthArgv is not an argv";
  const argv = config.data.healthArgv;
  if (argv === undefined) return null;
  try {
    const proc = await executor.exec(argv, {
      cwd: ctx.frmHome,
      env: { PATH: ctx.path },
      stdin: "ignore",
    });
    void readText(proc.stdout);
    void readText(proc.stderr);
    const timeout = ctx.settings["executor.health_timeout_ms"];
    if (!(await settlesWithin(proc.exited, ctx.clock, timeout))) {
      proc.kill("SIGKILL");
      return `no exit within ${timeout} ms`;
    }
    const { code } = await proc.exited;
    return code === 0 ? null : `the check exited ${String(code)}`;
  } catch (e) {
    return asFrmError(e, "internal", "cannot start the check").message;
  }
}
