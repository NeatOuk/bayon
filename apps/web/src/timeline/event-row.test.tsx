import type { EventItem } from "@bayon/proto";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { text } from "@/test/fixtures";
import { renderWithProviders, stubFetch } from "@/test/render";
import { TimelineView } from "@/timeline/timeline";

const at = (id: number) => ({
  id,
  ts: 1_800_000_000_000 + id,
  runner_type: "fixture.line",
});
const usage = {
  tokens_in: 1_200,
  tokens_out: 340,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
};

/** Every kind the other suites do not render, with the facts its row must show. */
const KINDS: readonly (readonly [EventItem, readonly string[]])[] = [
  [
    {
      ...at(1),
      kind: "session_init",
      payload: { runner_session_id: "rs-1", model: "model-a", cwd: "/work" },
    },
    ["session rs-1", "model-a", "/work"],
  ],
  [{ ...at(2), kind: "turn_start", payload: {} }, ["turn start"]],
  [
    { ...at(3), kind: "turn_end", payload: { stop_reason: "end_turn", usage } },
    ["turn end", "end_turn", "1200 in · 340 out"],
  ],
  [
    { ...at(4), kind: "usage", payload: { usage, cost_usd: 0.12 } },
    ["1200 in · 340 out", "$0.1200"],
  ],
  [
    {
      ...at(5),
      kind: "todo",
      payload: {
        items: [
          { text: "write tests", status: "completed" },
          { text: "implement", status: "in_progress" },
          { text: "ship", status: "pending" },
        ],
      },
    },
    ["1/3 done", "now: implement"],
  ],
  [
    {
      ...at(6),
      kind: "mcp_call",
      tool_name: "ticket.get",
      payload: { server: "foreman", args_digest: "ab12" },
    },
    ["foreman.ticket.get", "ab12"],
  ],
  [
    {
      ...at(7),
      kind: "approval_request",
      tool_name: "shell",
      payload: { input: { cmd: "rm -rf dist" }, risk: "high" },
    },
    ["approve shell", "risk high", "rm -rf dist"],
  ],
  [
    {
      ...at(8),
      kind: "runner_native",
      payload: { raw: { type: "brand_new" }, issues: ["kind: unknown"] },
    },
    ["fixture.line", "kind: unknown"],
  ],
  [
    {
      ...at(9),
      kind: "terminal",
      payload: {
        outcome: "failed",
        error: {
          class: "runner_exited_without_terminal",
          message: "stream ended",
          retryable: false,
        },
        cost_usd: 0.3,
      },
    },
    ["run failed", "stream ended", "$0.30"],
  ],
  [
    {
      ...at(10),
      kind: "command",
      exit_code: 0,
      payload: {
        argv: ["pnpm", "build"],
        duration_ms: 1_500,
        output_path: "logs/tool/c2.txt",
      },
    },
    ["pnpm build", "exit 0", "1.5s", "logs/tool/c2.txt"],
  ],
];

test("every canonical kind renders its facts", () => {
  renderWithProviders(
    <TimelineView sessionId="s1" items={KINDS.map(([event]) => event)} />,
  );
  const rows = screen.getAllByTestId("event-row");
  for (const [event, facts] of KINDS) {
    const row = rows.find((r) => r.dataset.eventId === String(event.id));
    for (const fact of facts) expect(row?.textContent).toContain(fact);
  }
});

test("a full-text fetch that fails says why", async () => {
  stubFetch({});
  renderWithProviders(
    <TimelineView
      sessionId="s1"
      items={[{ ...text(1), truncated: true, bytes_original: 9_000 }]}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /full text/i }));
  expect((await screen.findByRole("alert")).textContent).toContain("/api/v1/");
});
