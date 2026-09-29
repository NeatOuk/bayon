import { parse } from "yaml";
import { expect, test } from "vitest";
import {
  renderMissionMarkdown,
  renderTicketMarkdown,
  type TicketExportView,
} from "./render.js";

/** The text between the two `---` frontmatter fences, parsed. */
function frontmatterOf(rendered: string): unknown {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(rendered);
  if (match?.[1] === undefined) throw new Error("no frontmatter fence found");
  return parse(match[1]);
}

const BASE: TicketExportView = {
  key: "T-3",
  title: "Add the thing",
  status: "backlog",
  type: "feature",
  tier: "standard",
  priority: 3,
  costUsd: 1.25,
  branch: null,
  prUrl: null,
  bodyMd: "Do the thing.",
  acceptanceMd: "It does the thing.",
};

test("renders frontmatter that round-trips back to the source fields", () => {
  const rendered = renderTicketMarkdown({
    ...BASE,
    gates: [{ kind: "code_review", state: "passed" }],
    branch: "frm/01ABC",
    prUrl: "https://example.test/pr/1",
  });
  expect(frontmatterOf(rendered)).toEqual({
    key: "T-3",
    status: "backlog",
    type: "feature",
    tier: "standard",
    priority: 3,
    cost_usd: 1.25,
    gates: [{ kind: "code_review", state: "passed" }],
    links: { branch: "frm/01ABC", pr_url: "https://example.test/pr/1" },
  });
});

test("body, acceptance, transition log and hand-offs render in order", () => {
  const rendered = renderTicketMarkdown({
    ...BASE,
    events: [
      {
        kind: "transition",
        actor: "session:s1",
        reason: "planned",
        createdAt: 1_700_000_000_000,
      },
    ],
    handoffs: [
      { fromSessionId: "s1", toSessionId: "s2", createdAt: 1_700_000_001_000 },
    ],
  });
  expect(rendered).toContain("# Add the thing");
  expect(rendered).toContain("## Acceptance");
  expect(rendered).toContain("It does the thing.");
  expect(rendered).toContain("## Transition log");
  expect(rendered).toContain(
    "2023-11-14T22:13:20.000Z · transition · session:s1 — planned",
  );
  expect(rendered).toContain("## Hand-offs");
  expect(rendered).toContain("s1 → s2");
  // Order: frontmatter, title, body, acceptance, transition log, hand-offs.
  const order = [
    "---",
    "# Add the thing",
    "Do the thing.",
    "## Acceptance",
    "## Transition log",
    "## Hand-offs",
  ].map((marker) => rendered.indexOf(marker));
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("empty body/acceptance/events/handoffs render a placeholder, never blank sections", () => {
  const rendered = renderTicketMarkdown({
    ...BASE,
    bodyMd: "",
    acceptanceMd: "",
  });
  expect(rendered).toContain("_none recorded_");
  const noneCount = rendered.split("_none recorded_").length - 1;
  expect(noneCount).toBe(4); // body, acceptance, transition log, hand-offs
});

test("timestamps render as UTC ISO-8601, never a raw epoch or local time", () => {
  const rendered = renderTicketMarkdown({
    ...BASE,
    events: [{ kind: "transition", actor: "a", reason: null, createdAt: 0 }],
  });
  expect(rendered).toContain("1970-01-01T00:00:00.000Z");
});

test("is deterministic: identical input renders identical bytes, called twice", () => {
  const view: TicketExportView = {
    ...BASE,
    gates: [{ kind: "plan_review", state: "passed" }],
    events: [{ kind: "transition", actor: "a", reason: "x", createdAt: 5 }],
    handoffs: [{ fromSessionId: "s1", toSessionId: null, createdAt: 6 }],
  };
  expect(renderTicketMarkdown(view)).toBe(renderTicketMarkdown(view));
  expect(renderTicketMarkdown(view)).toBe(renderTicketMarkdown({ ...view }));
});

test("renderMissionMarkdown is the rendered_md verbatim, with exactly one trailing newline", () => {
  expect(renderMissionMarkdown("# Mission\n\nDo good work.\n\n\n")).toBe(
    "# Mission\n\nDo good work.\n",
  );
  expect(renderMissionMarkdown("no trailing newline")).toBe(
    "no trailing newline\n",
  );
});
