import type { ConformanceSummary, RunnerCaps } from "@bayon/core";
import {
  CommandView,
  RunnerView,
  type CertificationView,
  type RunnerModelView,
  type RunnersView,
} from "@bayon/proto";

// Wire-shaped runner data (DTOs): every value here passes its proto schema. Runner ids are
// neutral names, as the GUI only ever shows what the rows say (Invariant 1).

export const summary = (
  o: Partial<ConformanceSummary> = {},
): ConformanceSummary => ({
  passed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14],
  failed: [],
  na: [12, 13],
  incomplete: [],
  unverified_caps: ["hooks", "pty"],
  certifiable: true,
  gate_eligible: true,
  unattended_allowed: true,
  ...o,
});

export const caps = (o: Partial<RunnerCaps> = {}): RunnerCaps => ({
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: true,
  toolApprovalCallback: false,
  sandboxModes: false,
  mcpClient: true,
  hooks: false,
  pty: false,
  outputSchema: false,
  imageInput: false,
  subagents: false,
  ...o,
});

export const certification = (
  o: Partial<CertificationView> = {},
): CertificationView => ({
  executor_id: "local",
  model_id: "runner-a.cheap",
  compression: false,
  model: "model-small",
  runner_version: "1.2.0",
  suite_version: "1",
  kit_hash: "sha256:kit",
  caps_hash: "sha256:caps",
  report_path: "/frm/docs/conformance/runner-a@local.md",
  gate_eligible: true,
  passed_at: 1_800_000_000_000,
  certified_at: 1_800_000_000_000,
  decertified_at: null,
  decertified_reason: null,
  summary: summary(),
  ...o,
});

/** One models row as GET /runners lists it: an adapter's, active, priced 0 unless told. */
export const modelView = (
  o: Partial<RunnerModelView> & Pick<RunnerModelView, "id" | "tier" | "model">,
): RunnerModelView => ({
  bound_roles: [],
  source: "adapter",
  active: true,
  effort: null,
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  price_cache_read_per_mtok: 0,
  price_cache_write_per_mtok: 0,
  context_tokens: null,
  settings: {},
  ...o,
});

export const runnerView = (
  o: Partial<RunnerView> & Pick<RunnerView, "id">,
): RunnerView =>
  RunnerView.parse({
    kind: "sdk",
    adapter: "adapter-a",
    version_detected: "1.2.0",
    enabled: true,
    caps: caps(),
    gate_eligible: true,
    conformance_passed_at: 1_800_000_000_000,
    certifications: [certification()],
    // The certified cheap model is the one a role runs; the complex one no role binds.
    models: [
      modelView({
        id: "runner-a.cheap",
        tier: "cheap",
        model: "model-small",
        bound_roles: ["builder"],
      }),
      modelView({
        id: "runner-a.complex",
        tier: "complex",
        model: "model-large",
      }),
    ],
    inactive_models: [],
    update: null,
    ...o,
  });

export const runnersView = (runners: readonly RunnerView[]): RunnersView => ({
  runners: [...runners],
});

export const commandView = (
  o: Partial<CommandView> & Pick<CommandView, "id">,
): CommandView =>
  CommandView.parse({
    ts: 1_800_000_000_000,
    type: "runner.conformance",
    payload: {},
    state: "pending",
    idempotency_key: null,
    claimed_at: null,
    attempts: 0,
    result: null,
    error: null,
    now: 1_800_000_000_000,
    ahead: [],
    ...o,
  });
