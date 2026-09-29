// `frm runner conformance <runner> [--model <id>] [--compression]`:
// asks the running API for a runner.conformance command per model, waits while the supervisor runs
// the §15 suite, then prints the report path and the verdict. Certification is per (runner,
// executor, model, compression): without --model, every active model of the runner that a role
// binding or a project's step tier runs is certified, one after another; with
// --compression, each run has context compression on (test 17 too) and certifies the compression-on
// certificate a project that compresses needs. Exit codes: 0 every run certified (passed_at set)
// with no failed test, 1 anything else, 2 no token or the deadline.
import { err, ok, type Clock, type FrmError, type Result } from "@bayon/core";
import {
  ApiErrorBody,
  CommandView,
  RunnerConformanceAccepted,
  RunnerConformanceResult,
  RunnersView,
} from "@bayon/proto";
import { z } from "zod";
import type { Fetch } from "./smoke/api-client.js";

export const DEFAULT_API_URL = "http://127.0.0.1:3010";
/** A live suite spends minutes; the fixture's takes under one. */
export const CONFORMANCE_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = 1_000;

export const ConformanceCliOptions = z.object({
  runnerId: z.string().min(1),
  executorId: z.string().min(1),
  /** One models row of the runner. Absent: every active model of it a role binding or a project
   * step tier runs. */
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
}

type Call = <T>(
  schema: z.ZodType<T>,
  path: string,
  body?: unknown,
) => Promise<Result<T>>;

function client(io: ConformanceIo, token: string): Call {
  const base = `${(io.env["FRM_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "")}/api/v1`;
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

/**
 * The models to certify: `--model`, else every active model of the runner that a role binding or a
 * project's step tier runs (GET /runners' bound_roles). None bound is an error that names
 * `--model` and the choices.
 */
async function modelsToRun(
  o: ConformanceCliOptions,
  call: Call,
): Promise<Result<readonly string[]>> {
  if (o.modelId !== undefined) return ok([o.modelId]);
  const runners = await call(RunnersView, "/runners");
  if (!runners.ok) return runners;
  const runner = runners.value.runners.find((r) => r.id === o.runnerId);
  if (runner === undefined) {
    return err({
      class: "not_found",
      message: `no runner ${o.runnerId} (GET /runners)`,
      retryable: false,
    });
  }
  const bound = runner.models.filter((m) => m.bound_roles.length > 0);
  if (bound.length === 0) {
    const all = runner.models.map((m) => m.id).join(", ");
    return err({
      class: "validation",
      message: `no role binding or project step tier runs a model of ${o.runnerId}: pass --model <id> (${all === "" ? "it has no active model" : `one of ${all}`})`,
      retryable: false,
    });
  }
  return ok(bound.map((m) => m.id));
}

export async function runnerConformance(
  o: ConformanceCliOptions,
  io: ConformanceIo,
): Promise<number> {
  const token = io.env["FRM_API_TOKEN"];
  if (token === undefined || token === "") {
    io.out("FAIL  set FRM_API_TOKEN: the operator's API bearer");
    return 2;
  }
  const call = client(io, token);
  const models = await modelsToRun(o, call);
  if (!models.ok) {
    io.out(`FAIL  ${models.error.message}`);
    return 1;
  }
  // One at a time, as the supervisor runs them anyway; the worst exit wins.
  let worst = 0;
  for (const modelId of models.value) {
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
