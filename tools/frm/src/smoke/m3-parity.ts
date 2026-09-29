import { join } from "node:path";
import { ok } from "@bayon/core";
import type { ConfigRows } from "@bayon/db/operator";
import {
  SHIPPED_ALLOWLISTS,
  type CreateTicketRequest,
  type GateView,
} from "@bayon/proto";
import {
  FIXTURE_RUNNER_ID,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { PARITY } from "../parity-config.js";
import { SMOKE, profile } from "./config.js";
import {
  BASE_BRANCH,
  DOCTRINE_PATH,
  createFixtureRepo,
  type FixtureRepo,
} from "./fixture-repo.js";
import { evidenceProblems, gateProblems } from "./m3-assertions.js";
import { M3, handoffRun } from "./m3-config.js";
import type { ExpectedCall } from "./m1-assertions.js";

// Step 10 of `frm smoke --m3`: the first smoke that opens, runs and decides a real
// `parity_check` gate.
//
// Until this step the switch and the rows existed and nothing exercised them: `gates.parity_check`
// was never turned on in a smoke, every smoke workspace was `kind: "single"` so `isMultiRepo` was
// false, and the parity checker's rows were asserted against `m3Rows`' return value rather than
// end to end. A gate whose only proof is a unit test is a gate an operator finds broken.
//
// What it costs is one builder session and two gates, which is why T4 is **trivial**: submit_plan
// advances it straight to `planned` (M3 amendment c), so no plan_review opens and no second
// reviewer is paid for. The other three tickets are on a `single` workspace, so turning the switch
// on moves nothing for them.

export const M3_PARITY = {
  workspace: "smoke-ws-multi",
  /** The primary takes the same rel_path as the single workspace's, so HEAD is read the same way. */
  primary: { repo: "smoke-multi-app", relPath: SMOKE.relPath },
  dep: { repo: "smoke-multi-lib", relPath: "lib" },
  agent: "smoke-m3-spike-parity",
  planPath: M3.planPath,
} as const;

/** T4's plan, committed by its one session. */
const PLAN = `# Plan\n\n1. Nothing to build: this ticket's parity_check is what is tested.\n`;

/**
 * T4, on the multi-repo workspace. **Trivial** (no complexity facts), so submit_plan carries it
 * past plan_review. Its body carries the stand-in's clean-review marker, so the round's code_review
 * passes without a planted bug — this step is about parity, and a red code_review would only hide
 * whether pass_review was refused for the right reason.
 */
export const M3_PARITY_TICKET: CreateTicketRequest = {
  title: "M3 smoke: a multi-repo ticket opens parity_check",
  type: "feature",
  body_md: [
    "Two repos in one workspace: the round opens parity_check beside code_review, and the",
    "parity job decides it from the mirrors and the database.",
    "",
    M3.cleanReviewMarker,
  ].join("\n"),
  workspace_id: M3_PARITY.workspace,
};

/** The two origin repos of the multi workspace, created under `home`. */
export interface ParityRepos {
  readonly primary: FixtureRepo;
  readonly dep: FixtureRepo;
}

export function createParityRepos(home: string) {
  const primary = createFixtureRepo(join(home, "multi-app"));
  if (!primary.ok) return primary;
  const dep = createFixtureRepo(join(home, "multi-lib"));
  return dep.ok ? ok({ primary: primary.value, dep: dep.value }) : dep;
}

const repoRow = (id: string, repo: FixtureRepo) => ({
  id,
  name: id,
  origin_url: repo.origin,
  mirror_path: repo.mirror,
  default_base_branch: BASE_BRANCH,
  doctrine_paths_json: JSON.stringify([DOCTRINE_PATH]),
});

/**
 * T4's script: commit the plan, start_spike, then submit_plan. The ticket is trivial, so the API's
 * advance lands it in `planned` rather than `plan_review` — the one thing this script says that
 * `spikeScript` does not.
 */
const spikeScript = (ticketId: string): FixtureScriptInput => ({
  runs: [
    {
      appends: [{ path: M3_PARITY.planPath, text: PLAN }],
      commit: "plan: what this ticket builds",
      events: [{ kind: "turn_start", runner_type: "smoke.step", payload: {} }],
      mcp: [
        {
          tool: "ticket_get",
          args: { ticket: ticketId },
          expect: { fields: { "ticket.status": "staffed" } },
          save: { v: "ticket.version" },
        },
        {
          tool: "ticket_update",
          args: {
            ticket: ticketId,
            version: { $saved: "v" },
            status: "spiking",
          },
          expect: { fields: { status: "spiking" } },
          save: { v: "version" },
        },
        {
          tool: "ticket_update",
          args: {
            ticket: ticketId,
            version: { $saved: "v" },
            plan_path: M3_PARITY.planPath,
            // A trivial ticket opens no plan_review, so the edge carries it on to `planned`
            // (M3 amendment c): asking for plan_review and landing in planned is the
            // documented behaviour, and this expectation is what pins it.
            status: "plan_review",
          },
          expect: { fields: { status: "planned" } },
          save: { v: "version" },
        },
      ],
      events_after: [
        {
          kind: "turn_end",
          runner_type: "smoke.step",
          payload: {
            usage: {
              tokens_in: 400,
              tokens_out: 80,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
            },
            stop_reason: "end_turn",
          },
        },
      ],
    },
    // spiking -> planned ends the spike phase, so the API ships a session.handoff and the
    // supervisor starts a second run. Scripted, or the fixture repeats the working run
    // and commits the plan a second time — moving the HEAD the gate is pinned to.
    handoffRun("spike"),
  ],
});

/** Its MCP calls, in order, across both runs. */
export const M3_PARITY_CALLS: readonly ExpectedCall[] = [
  { tool: "ticket_get", outcome: "ok" },
  { tool: "ticket_update", outcome: "ok" },
  { tool: "ticket_update", outcome: "ok" },
  { tool: "handoff_write", outcome: "ok" },
];

/**
 * The repos and the workspace they sit in, seeded before T4 is filed (a ticket names its
 * workspace). No runner or executor is referenced but `default_executor_id`, which boot upserts.
 */
export const parityPlaceRows = (r: ParityRepos): ConfigRows => ({
  repos: [
    repoRow(M3_PARITY.primary.repo, r.primary),
    repoRow(M3_PARITY.dep.repo, r.dep),
  ],
  workspaces: [
    {
      id: M3_PARITY.workspace,
      name: M3_PARITY.workspace,
      kind: "multi",
      default_executor_id: SMOKE.executor,
    },
  ],
  workspace_repos: [
    {
      workspace_id: M3_PARITY.workspace,
      repo_id: M3_PARITY.primary.repo,
      rel_path: M3_PARITY.primary.relPath,
      role: "primary",
    },
    {
      workspace_id: M3_PARITY.workspace,
      repo_id: M3_PARITY.dep.repo,
      rel_path: M3_PARITY.dep.relPath,
      role: "dep",
    },
  ],
});

/** The one agent that works T4; its script is scripted on T4's id, so it is seeded after it. */
export async function parityAgentRows(o: {
  readonly now: number;
  readonly ticketId: string;
}): Promise<ConfigRows> {
  return {
    profiles: [
      await profile(
        M3_PARITY.agent,
        FIXTURE_RUNNER_ID,
        "standard",
        { script: spikeScript(o.ticketId) },
        o.now,
        SHIPPED_ALLOWLISTS.builder,
      ),
    ],
    agents: [
      {
        id: M3_PARITY.agent,
        name: M3_PARITY.agent,
        kind: "builder",
        runner_id: FIXTURE_RUNNER_ID,
        executor_id: SMOKE.executor,
        profile_id: M3_PARITY.agent,
        workspace_id: M3_PARITY.workspace,
        created_at: o.now,
      },
    ],
  };
}

/** What a passing parity_check must show: the parity job, on local, heuristic, no findings. */
export function parityGateProblems(
  g: GateView | undefined,
  want: { readonly baseSha: string; readonly headSha: string },
): string[] {
  const state = gateProblems(
    g,
    { kind: "parity_check", attempt: 1 },
    { state: "passed", reason: null },
  );
  if (g === undefined || state.length > 0) return state;
  return evidenceProblems(g, {
    runnerId: PARITY.runnerId,
    executorId: PARITY.executor,
    baseSha: want.baseSha,
    headSha: want.headSha,
    findings: 0,
    // SCRIPT_CAPS.outputSchema is false, so collect() holds the job's answer to its FINDINGS
    // sentinel () — never the schema path a reviewer takes.
    parse: "heuristic",
    singleRunner: false,
  });
}
