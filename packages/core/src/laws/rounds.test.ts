import { describe, expect, test } from "vitest";
import {
  UNPINNED,
  planGateEffects,
  planRound,
  subjectOf,
  type RoundGateFact,
} from "./rounds.js";
import { resolveEdge } from "./table.js";

// A transition's gate effects (M3 amendment h): rounds at one shared attempt across every repo,
// nothing new while that kind runs, and the running gates an edge supersedes.

describe("subjectOf", () => {
  const ticket = { non_trivial: true, plan_path: "docs/spikes/T1.md" };

  test("a plan_review reviews the plan document", () => {
    expect(subjectOf("plan_review", ticket)).toEqual({
      subject_kind: "plan",
      subject_ref: "docs/spikes/T1.md",
    });
  });

  test("a parity_check's and a qa_harness's subject is the workspace, not a repo's range", () => {
    // parity because the property it checks is the workspace's; qa_harness because the
    // command it runs is the project's one command, not one repo's. Both open
    // repo-less, and a `workspace` subject is what keeps H3 from refusing a repo-less pin.
    for (const kind of ["parity_check", "qa_harness"] as const) {
      expect(subjectOf(kind, ticket), kind).toEqual({
        subject_kind: "workspace",
        subject_ref: UNPINNED,
      });
    }
  });

  test("every other kind reviews a diff", () => {
    for (const kind of [
      "code_review",
      "ce_review",
      // lint_check runs a repo's command on the pinned range, so its subject is that diff and it
      // is judged for base drift like any other diff gate.
      "lint_check",
    ] as const) {
      expect(subjectOf(kind, ticket)).toEqual({
        subject_kind: "diff",
        subject_ref: UNPINNED,
      });
    }
  });
});

const TRIVIAL = { non_trivial: false, plan_path: "docs/spikes/T1.md" };
const COMPLEX = { ...TRIVIAL, non_trivial: true };

const row = (
  id: string,
  kind: string,
  attempt: number,
  state = "failed",
  repo_id: string | null = null,
  round = 1,
): RoundGateFact => ({ id, kind, repo_id, attempt, round, state });

const edgeGates = (from: string, to: string) => {
  const edge = resolveEdge(
    from as "building",
    to as "code_review",
    "building" as const,
  );
  if (edge === undefined) throw new Error(`no edge ${from} → ${to}`);
  return edge.gates;
};

describe("planRound", () => {
  test("a trivial ticket's submit_plan opens nothing (amendment c)", () => {
    const opens = edgeGates("spiking", "plan_review").opens;
    expect(
      planRound({
        opens,
        ticket: TRIVIAL,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      }),
    ).toEqual([]);
  });

  test("a non-trivial submit_plan opens plan_review 1 on the plan", () => {
    const opens = edgeGates("spiking", "plan_review").opens;
    expect(
      planRound({
        opens,
        ticket: COMPLEX,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      }),
    ).toEqual([
      {
        kind: "plan_review",
        repo_id: null,
        attempt: 1,
        round: 1,
        subject_kind: "plan",
        subject_ref: "docs/spikes/T1.md",
      },
    ]);
  });

  test("a plan_review without a plan_path starts with an empty subject", () => {
    const opens = edgeGates("spiking", "plan_review").opens;
    const [first] = planRound({
      opens,
      ticket: { non_trivial: true, plan_path: null },
      gates: [],
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(first?.subject_ref).toBe("");
  });

  test("request_review opens code_review always and ce_review when non-trivial, each at 1", () => {
    const opens = edgeGates("building", "code_review").opens;
    const trivial = planRound({
      opens,
      ticket: TRIVIAL,
      gates: [],
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(trivial.map((g) => g.kind)).toEqual(["code_review"]);
    const complex = planRound({
      opens,
      ticket: COMPLEX,
      gates: [],
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(complex.map((g) => [g.kind, g.attempt, g.subject_ref])).toEqual([
      ["code_review", 1, UNPINNED],
      ["ce_review", 1, UNPINNED],
    ]);
  });

  test("one shared attempt number across every repo: one past the highest", () => {
    const opens = edgeGates("review_fix", "code_review").opens;
    const gates = [
      row("g1", "code_review", 1, "failed", "r1"),
      row("g2", "code_review", 2, "failed", "r2"),
      row("g3", "code_review", 1, "passed", "r3"),
    ];
    const round = planRound({
      opens,
      ticket: TRIVIAL,
      gates,
      repos: ["r1", "r2", "r3"],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(round.map((g) => [g.repo_id, g.attempt])).toEqual([
      ["r1", 3],
      ["r2", 3],
      ["r3", 3],
    ]);
  });

  test("a kind already running opens nothing new; the other kind still opens", () => {
    const opens = edgeGates("review_fix", "code_review").opens;
    const round = planRound({
      opens,
      ticket: COMPLEX,
      gates: [row("g1", "code_review", 1, "running")],
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(round.map((g) => [g.kind, g.attempt])).toEqual([["ce_review", 1]]);
  });

  // `multiRepo` is one fact: the ticket's workspace has more than one repo AND the
  // operator turned `gates.parity_check` on. The same fact decides pass_review's requirement, so a
  // round can never open a gate no edge asks for, nor leave a ticket waiting for one it never opened.
  describe("parity_check", () => {
    const round = edgeGates("building", "code_review").opens;

    test("off (the default), or a single workspace: no parity gate at all", () => {
      const opened = planRound({
        opens: round,
        ticket: COMPLEX,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => g.kind)).toEqual(["code_review", "ce_review"]);
    });

    test("on: one repo-less gate, whatever repos the ticket touches", () => {
      const opened = planRound({
        opens: round,
        ticket: TRIVIAL,
        gates: [],
        repos: ["r1", "r2"],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.repo_id, g.subject_kind])).toEqual([
        ["code_review", "r1", "diff"],
        ["code_review", "r2", "diff"],
        // Parity is a property of the workspace, so one gate answers for both repos (§3.1).
        ["parity_check", null, "workspace"],
      ]);
    });

    test("on: a resubmit opens the next attempt of it beside the others", () => {
      const opened = planRound({
        opens: edgeGates("review_fix", "code_review").opens,
        ticket: TRIVIAL,
        gates: [
          row("g1", "code_review", 1, "failed"),
          row("g2", "parity_check", 1, "failed"),
        ],
        repos: [],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.attempt])).toEqual([
        ["code_review", 2],
        ["parity_check", 2],
      ]);
    });

    test("a running parity_check opens nothing new", () => {
      const opened = planRound({
        opens: round,
        ticket: TRIVIAL,
        gates: [row("g1", "parity_check", 1, "running")],
        repos: [],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => g.kind)).toEqual(["code_review"]);
    });

    test("request_fix supersedes it beside code_review and ce_review", () => {
      const effects = planGateEffects({
        edge: edgeGates("code_review", "review_fix"),
        ticket: COMPLEX,
        gates: [
          row("c", "code_review", 1, "running"),
          row("e", "ce_review", 1, "running"),
          row("p", "parity_check", 1, "running"),
        ],
        repos: [],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(effects).toEqual({ supersede: ["c", "e", "p"], open: [] });
    });

    // pass_review closes the round, so it leaves none of its gates running. The
    // required ones cannot be (a running latest attempt is gate_not_passed); one that stopped
    // being required while it ran can — the operator turned `gates.parity_check` off.
    test("pass_review supersedes a parity_check the switch stopped requiring", () => {
      const effects = planGateEffects({
        edge: edgeGates("code_review", "qa_harness"),
        ticket: TRIVIAL,
        gates: [
          row("c", "code_review", 1, "passed"),
          row("p", "parity_check", 1, "running"),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(effects).toEqual({ supersede: ["p"], open: [] });
    });

    // `isPerRepoGate` wins over `only`. A rerun that named a repo would otherwise
    // open the gate at that repo_id, while `gatePassed` looks for a non-per-repo kind at
    // repo_id = null — a gate no law would ever find, on a ticket that then cannot leave
    // code_review. Reachable the moment rerunGate stops refusing the kind (M4).
    test("a rerun of it is repo-less even when `only` names a repo", () => {
      const opened = planRound({
        opens: [{ gate: "parity_check", when: "always" }],
        ticket: TRIVIAL,
        gates: [row("g1", "parity_check", 1, "failed")],
        repos: ["r1", "r2"],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
        only: { repo_id: "r1" },
      });
      expect(opened.map((g) => [g.kind, g.repo_id, g.attempt])).toEqual([
        ["parity_check", null, 2],
      ]);
    });
  });

  test("`only` opens one repo (a rerun)", () => {
    const opens = [{ gate: "code_review", when: "always" }] as const;
    const round = planRound({
      opens,
      ticket: TRIVIAL,
      gates: [row("g1", "code_review", 4, "failed", "r2")],
      repos: ["r1", "r2"],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
      only: { repo_id: "r2" },
    });
    expect(round.map((g) => [g.repo_id, g.attempt])).toEqual([["r2", 5]]);
  });

  // lint_check rides in the same round, and is per repo: its command is that repo's
  // `repos.lint_cmd`, so two repos of one workspace are linted apart.
  describe("lint_check", () => {
    const round = edgeGates("building", "code_review").opens;

    test("off: the round opens no lint_check at all", () => {
      const opened = planRound({
        opens: round,
        ticket: TRIVIAL,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => g.kind)).toEqual(["code_review"]);
    });

    test("on: one diff gate per touched repo, beside code_review", () => {
      const opened = planRound({
        opens: round,
        ticket: TRIVIAL,
        gates: [],
        repos: ["r1", "r2"],
        multiRepo: false,
        lintRepos: ["r1", "r2"],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.repo_id, g.subject_kind])).toEqual([
        ["code_review", "r1", "diff"],
        ["code_review", "r2", "diff"],
        ["lint_check", "r1", "diff"],
        ["lint_check", "r2", "diff"],
      ]);
    });

    // `lintRepos` is the repos that declare a `repos.lint_cmd`, a subset of
    // `ticket_repos` — code_review covers every repo the ticket touches, lint_check only the ones
    // with something to run. Before this, one repo's command opened the gate on all of them and
    // the job failed in the repo that had none.
    test("on for one repo of two: code_review covers both, lint_check only that one", () => {
      const opened = planRound({
        opens: round,
        ticket: TRIVIAL,
        gates: [],
        repos: ["r1", "r2"],
        multiRepo: false,
        lintRepos: ["r1"],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.repo_id])).toEqual([
        ["code_review", "r1"],
        ["code_review", "r2"],
        ["lint_check", "r1"],
      ]);
    });

    test("on: a resubmit opens the next attempt of it beside the others", () => {
      const opened = planRound({
        opens: edgeGates("review_fix", "code_review").opens,
        ticket: TRIVIAL,
        gates: [
          row("g1", "code_review", 1, "failed"),
          row("g2", "lint_check", 1, "failed"),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [null],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.attempt])).toEqual([
        ["code_review", 2],
        ["lint_check", 2],
      ]);
    });

    test("request_fix supersedes it with the rest of the round", () => {
      const effects = planGateEffects({
        edge: edgeGates("code_review", "review_fix"),
        ticket: TRIVIAL,
        gates: [
          row("c", "code_review", 1, "running"),
          row("l", "lint_check", 1, "running"),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [null],
        qaConfigured: false,
        qaCi: false,
      });
      expect(effects).toEqual({ supersede: ["c", "l"], open: [] });
    });

    // The switch flipped off while the gate ran: pass_review closes the round rather than leaving
    // an orphan running that request_fix would then be blocked by ('s reason).
    test("pass_review supersedes a lint_check the switch stopped requiring", () => {
      const effects = planGateEffects({
        edge: edgeGates("code_review", "qa_harness"),
        ticket: TRIVIAL,
        gates: [
          row("c", "code_review", 1, "passed"),
          row("l", "lint_check", 1, "running"),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(effects).toEqual({ supersede: ["l"], open: [] });
    });
  });

  //, 023. A round is a batch: every gate one planRound call opens shares a number, one
  // past the ticket's highest. Without it the laws cannot tell "this round opened none of that
  // kind" from "this ticket never had one", which is the cross-round evidence hole.
  describe("the round marker", () => {
    const opens = edgeGates("review_fix", "code_review").opens;

    test("a ticket with no gates opens round 1; every kind of the round shares it", () => {
      const opened = planRound({
        opens,
        ticket: COMPLEX,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.kind, g.round])).toEqual([
        ["code_review", 1],
        ["ce_review", 1],
      ]);
    });

    test("the next round is one past the highest, whatever the attempts say", () => {
      // A retry bumped code_review to attempt 3 inside round 2: the next round is 3, not 4.
      const opened = planRound({
        opens,
        ticket: TRIVIAL,
        gates: [
          row("g1", "code_review", 1, "failed", null, 1),
          row("g2", "code_review", 2, "failed", null, 2),
          row("g3", "code_review", 3, "failed", null, 2),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(opened.map((g) => [g.attempt, g.round])).toEqual([[4, 3]]);
    });

    test("a rerun stays in the round it reruns: a new attempt, the same round", () => {
      const opened = planRound({
        opens: [{ gate: "code_review", when: "always" }],
        ticket: TRIVIAL,
        gates: [
          row("g1", "code_review", 1, "failed", null, 1),
          row("g2", "code_review", 2, "failed", null, 2),
          row("g3", "ce_review", 1, "passed", null, 2),
        ],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
        only: { repo_id: null },
      });
      // Round 3 would strand round 2's passed ce_review one round behind, and pass_review would
      // then refuse a ticket whose every gate had in fact been decided.
      expect(opened.map((g) => [g.attempt, g.round])).toEqual([[3, 2]]);
    });

    test("request_fix supersedes round 2 without opening one; the resubmit opens round 3", () => {
      const round2 = [
        row("c", "code_review", 2, "running", null, 2),
        row("p", "parity_check", 2, "running", null, 2),
      ];
      const fix = planGateEffects({
        edge: edgeGates("code_review", "review_fix"),
        ticket: TRIVIAL,
        gates: round2,
        repos: [],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(fix).toEqual({ supersede: ["c", "p"], open: [] });
      const resubmit = planGateEffects({
        edge: edgeGates("review_fix", "code_review"),
        ticket: TRIVIAL,
        gates: round2.map((g) => ({ ...g, state: "failed" })),
        repos: [],
        multiRepo: true,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(resubmit.open.map((g) => [g.kind, g.round])).toEqual([
        ["code_review", 3],
        ["parity_check", 3],
      ]);
    });
  });

  // `pass_review` opens the QA gate of the status it enters, and only for a project that
  // has a harness. Opening it unconditionally would stop every other project in `qa_harness` behind
  // a gate nothing can run; opening it never would leave `pass_harness` with nothing to read.
  describe("qa_harness", () => {
    const passReview = () => edgeGates("code_review", "qa_harness");

    test("a project with a harness gets one gate, repo-less, over the workspace", () => {
      const opened = planRound({
        opens: passReview().opens,
        ticket: TRIVIAL,
        gates: [row("c", "code_review", 1, "passed")],
        repos: ["r1", "r2"],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: true,
        qaCi: false,
      });
      expect(opened).toEqual([
        {
          kind: "qa_harness",
          repo_id: null,
          attempt: 1,
          round: 2,
          subject_kind: "workspace",
          subject_ref: UNPINNED,
        },
      ]);
    });

    test("a project with none opens nothing, whatever its repos", () => {
      for (const repos of [[], ["r1"], ["r1", "r2"]]) {
        expect(
          planRound({
            opens: passReview().opens,
            ticket: TRIVIAL,
            gates: [],
            repos,
            multiRepo: true,
            lintRepos: [null],
            qaConfigured: false,
            qaCi: false,
          }),
          JSON.stringify(repos),
        ).toEqual([]);
      }
    });

    test("a CI project's gate opens with the pull_request subject; only qa_harness takes it", () => {
      const opened = planRound({
        opens: passReview().opens,
        ticket: TRIVIAL,
        gates: [],
        repos: ["r1"],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: true,
        qaCi: true,
      });
      expect(opened).toEqual([
        {
          kind: "qa_harness",
          repo_id: null,
          attempt: 1,
          round: 1,
          subject_kind: "pull_request",
          subject_ref: UNPINNED,
        },
      ]);
      expect(subjectOf("code_review", TRIVIAL, true).subject_kind).toBe("diff");
      const effects = planGateEffects({
        edge: passReview(),
        ticket: TRIVIAL,
        gates: [],
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: true,
        qaCi: true,
      });
      expect(effects.open.map((g) => g.subject_kind)).toEqual(["pull_request"]);
    });

    test("pass_review closes the review round and opens the QA one in the same move", () => {
      const effects = planGateEffects({
        edge: passReview(),
        ticket: TRIVIAL,
        gates: [row("l", "lint_check", 1, "running", "r1")],
        repos: ["r1"],
        multiRepo: false,
        lintRepos: ["r1"],
        qaConfigured: true,
        qaCi: false,
      });
      expect(effects.supersede).toEqual(["l"]);
      expect(effects.open.map((g) => g.kind)).toEqual(["qa_harness"]);
    });
  });
});

describe("planGateEffects", () => {
  const running = [
    row("p", "plan_review", 1, "running"),
    row("c", "code_review", 2, "running"),
    row("e", "ce_review", 2, "running"),
    row("old", "code_review", 1, "failed"),
  ];

  test("request_fix supersedes the running code_review and ce_review, and opens nothing", () => {
    const effects = planGateEffects({
      edge: edgeGates("code_review", "review_fix"),
      ticket: COMPLEX,
      gates: running,
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(effects).toEqual({ supersede: ["c", "e"], open: [] });
  });

  test("revise_plan supersedes only plan_review", () => {
    const effects = planGateEffects({
      edge: edgeGates("plan_review", "spiking"),
      ticket: COMPLEX,
      gates: running,
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(effects.supersede).toEqual(["p"]);
  });

  test("release, park, reject and split supersede every running gate", () => {
    for (const to of ["handoff_pending", "parked", "rejected", "split"]) {
      const effects = planGateEffects({
        edge: edgeGates("building", to),
        ticket: COMPLEX,
        gates: running,
        repos: [],
        multiRepo: false,
        lintRepos: [],
        qaConfigured: false,
        qaCi: false,
      });
      expect(effects, to).toEqual({ supersede: ["p", "c", "e"], open: [] });
    }
  });

  test("a superseded kind no longer counts as running when the same edge opens it", () => {
    const effects = planGateEffects({
      edge: {
        opens: [{ gate: "code_review", when: "always" }],
        supersede: "all",
      },
      ticket: TRIVIAL,
      gates: running,
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(effects.open.map((g) => [g.kind, g.attempt])).toEqual([
      ["code_review", 3],
    ]);
  });

  test("an edge with no gate effects does nothing", () => {
    const effects = planGateEffects({
      edge: edgeGates("planned", "building"),
      ticket: COMPLEX,
      gates: running,
      repos: [],
      multiRepo: false,
      lintRepos: [],
      qaConfigured: false,
      qaCi: false,
    });
    expect(effects).toEqual({ supersede: [], open: [] });
  });
});
