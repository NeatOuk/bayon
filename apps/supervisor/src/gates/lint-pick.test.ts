import { FakeClock } from "@bayon/core";
import { seedRows, seedSpine, tempDb, unwrap } from "@bayon/db/testing";
import type { RunnerAdapter } from "@bayon/runners";
import { createScriptAdapter } from "@bayon/runners/script";
import { afterAll, expect, test } from "vitest";
import { LINT_RUNNER_ID } from "../jobs/lint-agent.js";
import { chooseLintJob } from "./lint-pick.js";

// Who runs a lint_check. Not a pick: one fixed runner on one fixed executor, so the
// only questions are whether its rows exist and whether this host may run this branch's commands.

const clock = new FakeClock(Date.UTC(2026, 8, 14, 12));
const t = unwrap(await tempDb(clock));
// The `local` executor the job runs on: the supervisor upserts it at boot, and seedSpine is its
// stand-in here.
unwrap(await seedSpine(t.db, 1));
afterAll(() => t.cleanup());

const adapter: RunnerAdapter = createScriptAdapter({
  id: LINT_RUNNER_ID,
  argv: ["/bin/true"],
});
const ADAPTERS = new Map([[LINT_RUNNER_ID, adapter]]);
const NONE = new Map<string, RunnerAdapter>();

const choose = (o: {
  adapters?: ReadonlyMap<string, RunnerAdapter>;
  subjectExecutorId?: string;
}) =>
  chooseLintJob({
    db: t.db,
    adapters: o.adapters ?? ADAPTERS,
    subjectExecutorId: o.subjectExecutorId ?? "local",
  });

/** The refusal's detail, or a failure if the pick found a job after all. */
async function refusal(o: Parameters<typeof choose>[0]): Promise<string> {
  const r = unwrap(await choose(o));
  if (r.found !== null) throw new Error("expected no_reviewer, got a pick");
  return r.detail;
}

test("no adapter for the job: no_reviewer, naming the runner", async () => {
  const detail = await refusal({ adapters: NONE });
  expect(detail).toContain(LINT_RUNNER_ID);
  expect(detail).toContain("no adapter");
});

// §9.8's trust rule. The command is the *repo's* — `pnpm -w lint` resolves through a package.json
// script a builder can edit — so a branch built in a container must not have its scripts run on the
// supervisor's host. Refused here, with the reason and the way out named, rather than run.
test("a subject built on another executor is refused before any spawn", async () => {
  const detail = await refusal({ subjectExecutorId: "ctr-1" });
  expect(detail).toContain("ctr-1");
  expect(detail).toContain("§9.8");
  expect(detail).toContain("waive");
});

// The reason gates.lint_check ships off: with it on and no agent row, every ticket stops in
// code_review behind a gate nobody can decide but by waiving. The detail says how to fix it.
test("no kind='util' agent of the job: no_reviewer, naming `frm config apply`", async () => {
  expect(await refusal({})).toContain("frm config apply");
});

test("with the agent seeded: that agent, on local, with no output schema", async () => {
  unwrap(
    await seedRows(t.db, {
      runners: [
        {
          id: LINT_RUNNER_ID,
          kind: "script",
          adapter: LINT_RUNNER_ID,
          caps_json: "{}",
        },
      ],
      agents: [
        {
          id: "lint-checker",
          name: "lint-checker",
          kind: "util",
          runner_id: LINT_RUNNER_ID,
          executor_id: "local",
          created_at: 1,
        },
      ],
    }),
  );
  const r = unwrap(await choose({}));
  expect(r.found).toMatchObject({
    runnerId: LINT_RUNNER_ID,
    agentId: "lint-checker",
    executorId: "local",
    fallbackFrom: null,
    // Not a review, so neither flag is ever true: the evidence says the plain truth.
    singleRunnerReview: false,
    // SCRIPT_CAPS.outputSchema is false, so collect() holds the answer to its FINDINGS sentinel.
    outputSchema: false,
    profileId: null,
  });
});
