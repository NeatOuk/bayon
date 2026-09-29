// `frm runner conformance <runner> [--model <id>] [--compression]`:
// asks the running API for a runner.conformance command per model, waits while the supervisor runs
// the §15 suite, then prints the report path and the verdict. Certification is per (runner,
// executor, model, compression): without --model, every active model of the runner that a role
// binding, a project's step tier or an enabled agent runs is certified, one
// after another — or, when nothing uses one yet, the runner's default model; with
// --compression, each run has context compression on (test 17 too) and certifies the compression-on
// certificate a project that compresses needs. Exit codes: 0 every run certified (passed_at set)
// with no failed test, 1 anything else, 2 no token or the deadline.
import {
  err,
  isAgentRunner,
  ok,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  ApiErrorBody,
  CommandView,
  RunnerConformanceAccepted,
  RunnerConformanceResult,
  RunnersView,
} from "@bayon/proto";
import { z } from "zod";
import type { KeychainOptions } from "@bayon/executors";
import { NO_API_TOKEN, apiBaseOf, apiTokenOf } from "./api-access.js";
import type { Fetch } from "./smoke/api-client.js";

/** A live suite spends minutes; the fixture's takes under one. */
export const CONFORMANCE_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 1_000;

export const ConformanceCliOptions = z.object({
  runnerId: z.string().min(1),
  executorId: z.string().min(1),
  /** One models row of the runner. Absent: every active model of it in use, else its default. */
  modelId: z.string().min(1).optional(),
  /** With context compression on (spec M12): the compression-on certificate. */
  compression: z.boolean().default(false),
  /** Absolute: the supervisor has its own cwd. Absent: <FRM_HOME>/conformance on its host. */
  outDir: z.string().regex(/^\//).optional(),
  timeoutMs: z.int().positive(),
});
export type ConformanceCliOptions = z.infer<typeof ConformanceCliOptions>;

export interface ConformanceIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly fetch?: Fetch;
  readonly pollMs?: number;
  /** The `security` binary the bearer is read with; tests point it at a stand-in. */
  readonly keychain?: KeychainOptions;
}

type Call = <T>(
  schema: z.ZodType<T>,
  path: string,
  body?: unknown,
) => Promise<Result<T>>;

function client(io: ConformanceIo, origin: string, token: string): Call {
  const base = `${origin}/api/v1`;
  const fetcher: Fetch = io.fetch ?? ((url, init) => fetch(url, init));
  return async (schema, path, body) => {
    const label = `${body === undefined ? "GET" : "POST"} ${path}`;
    const fail = (e: Omit<FrmError, "message">, m: string) =>
      err({ ...e, message: `${label}: ${m}` });
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      const m = cause instanceof Error ? cause.message : String(cause);
      return fail(
        { class: "internal", retryable: true },
        `${m} (is the API up?)`,
      );
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const e = ApiErrorBody.safeParse(json);
      return e.success
        ? err({ ...e.data.error, message: `${label}: ${e.data.error.message}` })
        : fail({ class: "internal", retryable: false }, `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(json);
    return parsed.success
      ? ok(parsed.data)
      : fail(
          { class: "internal", retryable: false },
          z.prettifyError(parsed.error),
        );
  };
}

const yesNo = (b: boolean) => (b ? "yes" : "no");

function print(io: ConformanceIo, r: RunnerConformanceResult): void {
  const s = r.summary;
  io.out(`report   ${r.report_path}`);
  io.out(
    `verdict  certifiable ${yesNo(s.certifiable)} · gate_eligible ${yesNo(s.gate_eligible)} · unattended ${yesNo(s.unattended_allowed)}`,
  );
  io.out(
    `tests    ${s.passed.length} pass · ${s.failed.length} fail · ${s.na.length} N/A · ${s.incomplete.length} incomplete` +
      (s.failed.length > 0 ? ` (failed: ${s.failed.join(", ")})` : "") +
      (s.incomplete.length > 0
        ? ` (incomplete: ${s.incomplete.join(", ")})`
        : ""),
  );
  for (const t of r.teardown) io.out(`teardown ${t}`);
  io.out(storedLine(r));
}

/** What the row says: "certified" only when its passed_at is set. */
function storedLine(r: RunnerConformanceResult): string {
  const pair =
    r.model_id === null
      ? `(${r.runner_id}, ${r.executor_id})`
      : `(${r.runner_id}, ${r.executor_id}, ${r.model_id}${r.compression ? ", compression" : ""})`;
  if (!r.stored) {
    return r.teardown.length > 0
      ? "stored   nothing: the run did not end cleanly, so no certification was written or cleared"
      : "stored   nothing: not certifiable, so no certification was written or cleared";
  }
  return r.passed_at === null
    ? `stored   ${pair} as of runner ${r.runner_version}: stored, not certified (${r.summary.failed.length} failed)`
    : `stored   ${pair} is certified as of runner ${r.runner_version}`;
}

/** The tier a runner's default model is, when nothing uses one of its models yet. */
const DEFAULT_TIER = "standard";

/** The models a run certifies, and the line that says why these. */
interface Picked {
  readonly ids: readonly string[];
  readonly line: string | null;
}

/**
 * The models to certify: `--model`; else every active model of the runner that something uses — a
 * role binding, a project's step tier or an enabled agent, as GET /runners'
 * bound_roles lists them — each named with its uses; else, when nothing uses one yet (a runner no
 * project staffs), its default: the standard tier, else its first active model. Refused: an unknown
 * runner, a job runner (the supervisor's own, not an agent), a runner with no active model.
 */
async function modelsToRun(
  o: ConformanceCliOptions,
  call: Call,
): Promise<Result<Picked>> {
  if (o.modelId !== undefined) return ok({ ids: [o.modelId], line: null });
  const runners = await call(RunnersView, "/runners");
  if (!runners.ok) return runners;
  const runner = runners.value.runners.find((r) => r.id === o.runnerId);
  const refuse = (cls: "not_found" | "validation", message: string) =>
    err({ class: cls, message, retryable: false });
  if (runner === undefined) {
    return refuse(
      "not_found",
      `no runner ${o.runnerId}: the Runners page lists the ones there are`,
    );
  }
  if (!isAgentRunner(runner)) {
    return refuse(
      "validation",
      `runner ${o.runnerId} is one of the supervisor's own jobs, not an agent runner: there is nothing to certify`,
    );
  }
  const bound = runner.models.filter((m) => m.bound_roles.length > 0);
  if (bound.length > 0) {
    return ok({
      ids: bound.map((m) => m.id),
      line: `models   ${bound.map((m) => `${m.id} (used by ${m.bound_roles.join(", ")})`).join(" · ")}`,
    });
  }
  const standard = runner.models.find((m) => m.tier === DEFAULT_TIER);
  const fallback = standard ?? runner.models[0];
  if (fallback === undefined) {
    return refuse(
      "validation",
      `runner ${o.runnerId} has no active model, so there is nothing to certify`,
    );
  }
  const why =
    standard === undefined
      ? "its first active model"
      : `the ${DEFAULT_TIER} tier`;
  return ok({
    ids: [fallback.id],
    line: `models   ${fallback.id}: no project, agent or role uses a model of ${o.runnerId} yet, so its default (${why})`,
  });
}

export async function runnerConformance(
  o: ConformanceCliOptions,
  io: ConformanceIo,
): Promise<number> {
  const origin = apiBaseOf(io.env);
  if (!origin.ok) {
    io.out(`FAIL  ${origin.error.message}`);
    return 2;
  }
  const token = await apiTokenOf(io.env, io.keychain);
  if (!token.ok || token.value === undefined) {
    io.out(`FAIL  ${token.ok ? NO_API_TOKEN : token.error.message}`);
    return 2;
  }
  const call = client(io, origin.value, token.value);
  const models = await modelsToRun(o, call);
  if (!models.ok) {
    io.out(`FAIL  ${models.error.message}`);
    return 1;
  }
  if (models.value.line !== null) io.out(models.value.line);
  // One at a time, as the supervisor runs them anyway; the worst exit wins.
  let worst = 0;
  for (const modelId of models.value.ids) {
    const code = await runOne(o, modelId, call, io);
    worst = Math.max(worst, code);
    if (code === 2) break; // the deadline or no token: the rest would wait the same
  }
  return worst;
}

async function runOne(
  o: ConformanceCliOptions,
  modelId: string,
  call: Call,
  io: ConformanceIo,
): Promise<number> {
  const accepted = await call(
    RunnerConformanceAccepted,
    `/runners/${encodeURIComponent(o.runnerId)}/conformance`,
    {
      executor_id: o.executorId,
      model_id: modelId,
      ...(o.outDir === undefined ? {} : { report_dir: o.outDir }),
      ...(o.compression ? { compression: true } : {}),
    },
  );
  if (!accepted.ok) {
    io.out(`FAIL  ${accepted.error.message}`);
    return 1;
  }
  const id = accepted.value.command_id;
  io.out(
    `frm runner conformance · ${o.runnerId} · ${modelId} on ${o.executorId}${o.compression ? " · context compression" : ""} · command ${id}`,
  );
  const deadline = io.clock.now() + o.timeoutMs;
  for (;;) {
    const cmd = await call(CommandView, `/commands/${encodeURIComponent(id)}`);
    if (!cmd.ok) {
      io.out(`FAIL  ${cmd.error.message}`);
      return 1;
    }
    if (cmd.value.state === "failed") {
      io.out(
        `FAIL  ${cmd.value.error?.class ?? "internal"}: ${cmd.value.error?.message ?? "no error recorded"}`,
      );
      return 1;
    }
    if (cmd.value.state === "done") {
      const result = RunnerConformanceResult.safeParse(cmd.value.result);
      if (!result.success) {
        io.out(
          `FAIL  the command's result is not a conformance result: ${z.prettifyError(result.error)}`,
        );
        return 1;
      }
      print(io, result.data);
      const { stored, passed_at, summary } = result.data;
      return stored && passed_at !== null && summary.failed.length === 0
        ? 0
        : 1;
    }
    if (io.clock.now() >= deadline) {
      io.out(
        `FAIL  no result within ${o.timeoutMs / 1_000} s; command ${id} may still be running`,
      );
      return 2;
    }
    await io.clock.after(io.pollMs ?? POLL_MS);
  }
}
