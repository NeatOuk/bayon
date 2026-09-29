import {
  AcceptRefusalReason,
  StaffRefusalReason,
  hashToolset,
} from "@bayon/core";
import { expect, test } from "vitest";
import { z } from "zod";
import {
  CATALOGUE_TOOLS,
  HANDOFF_LIMITS,
  MCP_TOOLS,
  McpRefusalReason,
  McpRole,
  ROLE_MATRIX,
  SHIPPED_ALLOWLISTS,
  WORK_ROLES,
  listedTools,
  mcpTool,
  toolDefinitions,
  toolJsonSchema,
  toolsetFor,
  workRoleTools,
  type McpTool,
} from "./mcp-tools.js";

const names = (tools: readonly McpTool[]) => tools.map((t) => t.wire);
const ok = <T>(r: { ok: true; value: T } | { ok: false }): T => {
  if (!r.ok) throw new Error("expected ok");
  return r.value;
};

// §5.1: ~4 characters a token plus a 15 % margin (the runners' approximateTokens).
const approxTokens = (text: string) => Math.ceil((text.length / 4) * 1.15);

test("the catalogue: M1's 14 tools, M2's 6, M3's 2 and M7.6's 2 in §11.1 order, then conformance_echo; wire names with _, spec names dotted (amendments 1, 2)", () => {
  expect(names(MCP_TOOLS)).toEqual([
    "ticket_search",
    "ticket_get",
    "ticket_create",
    "ticket_update",
    "ticket_comment",
    "ticket_link",
    "ticket_staff",
    "mission_read",
    "mailbox_send",
    "mailbox_inbox",
    "handoff_write",
    "handoff_read",
    "handoff_accept",
    "handoff_request",
    "memory_search",
    "memory_append",
    "human_ask",
    "pulse_report",
    "probe_run",
    "artifact_attach",
    "finding_resolve",
    "gate_submit",
    "doc_search",
    "doc_get",
    "conformance_echo",
  ]);
  for (const tool of MCP_TOOLS) {
    expect(tool.wire).toMatch(/^[a-z]+_[a-z]+$/);
    expect(tool.specName).toBe(tool.wire.replace("_", "."));
    expect(tool.description.length, tool.wire).toBeLessThanOrEqual(
      descriptionMax(tool.wire),
    );
  }
});

// Design an earlier change §4: a description is ≤ 120 characters. handoff_write is the one exception: it
// states its bounds, so the model reads them before its first call rather than from a refusal
//. §8.6's budget is the served-allowlist test's, below.
const descriptionMax = (wire: string) => (wire === "handoff_write" ? 260 : 120);

test("ROLE_MATRIX is §11.1: only the orchestrator staffs, reports pulses and runs probes; reviewers and investigators never update; every role hands off", () => {
  expect(ROLE_MATRIX.orchestrator).toHaveLength(22);
  expect(ROLE_MATRIX.builder).not.toContain("ticket_staff");
  expect(ROLE_MATRIX.builder).toContain("ticket_update");
  for (const role of ["builder", "reviewer", "investigator"] as const) {
    expect(ROLE_MATRIX[role]).not.toContain("pulse_report");
    expect(ROLE_MATRIX[role]).not.toContain("probe_run");
  }
  for (const role of ["reviewer", "investigator"] as const) {
    expect(ROLE_MATRIX[role]).not.toContain("ticket_update");
    expect(ROLE_MATRIX[role]).not.toContain("ticket_staff");
  }
  // M3: finding_resolve is the builder's alone; gate_submit (pending) the reviewer's (§11.1).
  expect(ROLE_MATRIX.investigator).toHaveLength(18);
  expect(ROLE_MATRIX.reviewer).toHaveLength(19);
  for (const role of McpRole.options) {
    expect(ROLE_MATRIX[role].includes("finding_resolve"), role).toBe(
      role === "builder",
    );
    expect(ROLE_MATRIX[role].includes("gate_submit"), role).toBe(
      role === "reviewer",
    );
  }
  for (const role of WORK_ROLES) {
    expect(ROLE_MATRIX[role]).toEqual(
      expect.arrayContaining([
        "handoff_write",
        "handoff_read",
        "handoff_accept",
        "handoff_request",
      ]),
    );
  }
});

test("the orchestrator's shipped allowlist is a pulse's 10 tools: read, file, move, staff, note, ask, report, probe", () => {
  expect(
    names(ok(toolsetFor("orchestrator", SHIPPED_ALLOWLISTS.orchestrator))),
  ).toEqual([
    "ticket_search",
    "ticket_get",
    "ticket_create",
    "ticket_update",
    "ticket_comment",
    "ticket_staff",
    "mailbox_send",
    "human_ask",
    "pulse_report",
    "probe_run",
  ]);
});

test("the shipped allowlists give a builder 13 tools (M3: finding_resolve; M7.6: the doc tools) and a reviewer 7, hand-off tools among them (§8.6)", () => {
  expect(names(ok(toolsetFor("builder", SHIPPED_ALLOWLISTS.builder)))).toEqual([
    "ticket_get",
    "ticket_create",
    "ticket_update",
    "ticket_comment",
    "handoff_write",
    "handoff_accept",
    "handoff_request",
    "memory_append",
    "human_ask",
    "artifact_attach",
    "finding_resolve",
    "doc_search",
    "doc_get",
  ]);
  expect(
    names(ok(toolsetFor("reviewer", SHIPPED_ALLOWLISTS.reviewer))),
  ).toEqual([
    "ticket_get",
    "ticket_comment",
    "handoff_write",
    "handoff_accept",
    "human_ask",
    "doc_search",
    "doc_get",
  ]);
});

// M7.6: read-only, every work role's, and in no other role's row. Adding them changes
// tools/list, and so toolset_hash: a live session whose hash no longer matches is served nothing.
test("the doc tools are every work role's, read-only, and change the toolset hash they are added to", async () => {
  for (const wire of ["doc_search", "doc_get"]) {
    const t = mcpTool(wire) as McpTool;
    expect(t.roles, wire).toEqual(WORK_ROLES);
    expect(t.write, wire).toBe(false);
    expect(t.pending, wire).toBeUndefined();
    for (const role of WORK_ROLES)
      expect(ROLE_MATRIX[role], role).toContain(wire);
    expect(ROLE_MATRIX.conformance, wire).not.toContain(wire);
  }
  const hashOf = async (role: string, allowlist: readonly string[]) =>
    hashToolset(toolDefinitions(ok(toolsetFor(role, allowlist))));
  for (const role of ["builder", "reviewer"] as const) {
    const shipped = [...SHIPPED_ALLOWLISTS[role]];
    const without = shipped.filter((w) => !w.startsWith("doc_"));
    expect(without, role).toHaveLength(shipped.length - 2);
    expect(await hashOf(role, shipped), role).not.toBe(
      await hashOf(role, without),
    );
  }
  // doc_search pages like every other list tool; doc_get reads one page.
  expect(mcpTool("doc_search")?.cap.rows).toBe(20);
  expect(mcpTool("doc_get")?.cap.rows).toBeUndefined();
  const search = mcpTool("doc_search")?.input;
  expect(search?.safeParse({ q: "acceptance criteria" }).success).toBe(true);
  expect(search?.safeParse({ q: "x", space: "ONE", limit: 5 }).success).toBe(
    true,
  );
  for (const bad of [{ limit: 0 }, { limit: 21 }, { project: "P" }, { q: 1 }]) {
    expect(search?.safeParse({ q: "x", ...bad }).success, String(bad)).toBe(
      false,
    );
  }
  const get = mcpTool("doc_get")?.input;
  expect(get?.safeParse({ ref: "12345" }).success).toBe(true);
  expect(get?.safeParse({ ref: "r".repeat(501) }).success).toBe(false);
  // No tool schema carries a project: it comes from the caller's token (§11.1).
  expect(get?.safeParse({ ref: "1", project: "P" }).success).toBe(false);
});

test("toolsetFor is the role's matrix row intersected with the allowlist, pending tools left out", () => {
  const all = names(MCP_TOOLS);
  expect(names(ok(toolsetFor("reviewer", all)))).toEqual(
    ROLE_MATRIX.reviewer.filter((wire) => wire !== "gate_submit"),
  );
  expect(names(ok(toolsetFor("builder", ["ticket_staff"])))).toEqual([]);
  expect(ok(toolsetFor("builder", []))).toEqual([]);
});

test("a role outside the matrix gets no tools", () => {
  expect(ok(toolsetFor("qa", names(MCP_TOOLS)))).toEqual([]);
  expect(ok(toolsetFor("build", ["ticket_get"]))).toEqual([]);
});

test("an unknown or non-string allowlist entry is a validation error, so a typo is loud", () => {
  expect(toolsetFor("builder", ["ticket.get"])).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining("ticket.get"),
    },
  });
  expect(toolsetFor("builder", [42])).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

test("every input schema is a closed JSON object schema without $schema", () => {
  for (const tool of MCP_TOOLS) {
    const schema = toolJsonSchema(tool);
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(schema).not.toHaveProperty("$schema");
  }
});

test("listedTools is the tools/list payload and toolDefinitions hashes exactly it", () => {
  const tools = ok(toolsetFor("reviewer", SHIPPED_ALLOWLISTS.reviewer));
  const listed = listedTools(tools);
  expect(listed.map((t) => t.name)).toEqual(names(tools));
  expect(toolDefinitions(tools)).toEqual(
    listed.map((t) => ({
      name: t.name,
      schema: { description: t.description, input: t.inputSchema },
    })),
  );
});

test("toolset_hash moves with the tool set and ignores allowlist order", async () => {
  const hashOf = async (role: string, allowlist: readonly string[]) =>
    hashToolset(toolDefinitions(ok(toolsetFor(role, allowlist))));
  const builder = [...SHIPPED_ALLOWLISTS.builder];
  expect(await hashOf("builder", builder)).toBe(
    await hashOf("builder", builder.toReversed()),
  );
  expect(await hashOf("builder", builder)).not.toBe(
    await hashOf("builder", builder.slice(1)),
  );
  expect(await hashOf("builder", builder)).not.toBe(
    await hashOf("reviewer", builder),
  );
  expect(await hashOf("qa", builder)).toBe(await hashToolset([]));
});

const servable = (wires: readonly string[]) =>
  wires.filter((w) => mcpTool(w)?.pending !== true);

test("CATALOGUE_TOOLS is every tool but the pending ones, a valid allowlist", () => {
  expect(CATALOGUE_TOOLS).toEqual(servable(names(MCP_TOOLS)));
  expect(CATALOGUE_TOOLS).not.toContain("gate_submit");
  for (const role of WORK_ROLES) {
    // As an allowlist it lets the role's row decide: each role is served its whole row.
    expect(names(ok(toolsetFor(role, CATALOGUE_TOOLS))), role).toEqual(
      servable(ROLE_MATRIX[role]),
    );
  }
});

test("workRoleTools: a work role's servable row; none for any other role", () => {
  for (const role of WORK_ROLES) {
    expect(names(workRoleTools(role)), role).toEqual(
      servable(ROLE_MATRIX[role]),
    );
    expect(workRoleTools(role).length, role).toBeGreaterThan(0);
  }
  for (const role of ["conformance", "qa", "util", "nobody"]) {
    expect(workRoleTools(role), role).toEqual([]);
  }
});

// §8.6 budgets the tools a role is served at spawn, not the catalogue. M1's 14 tools cost ~1.4k
// alone and M2's six take the catalogue to ~1.95k. With the hand-off tools wired every
// role's whole row is over 1.5k (builder ~1.7k), so each role is served its shipped allowlist, and
// that is what the budget covers.
const cost = (tools: readonly McpTool[]) =>
  approxTokens(JSON.stringify(listedTools(tools)));

test("each shipped allowlist, as served, stays under 1.5k tokens (§8.6)", () => {
  for (const [role, allowlist] of Object.entries(SHIPPED_ALLOWLISTS)) {
    const served = ok(toolsetFor(role, allowlist));
    expect(served, role).toHaveLength(allowlist.length);
    expect(cost(served), role).toBeLessThan(1_500);
  }
});

test("inputs are bounded: human_ask takes 1-4 questions with 2-5 options", () => {
  const ask = MCP_TOOLS.find((t) => t.wire === "human_ask");
  const question = { question: "Ship it?", options: ["yes", "no"] };
  expect(ask?.input.safeParse({ questions: [question] }).success).toBe(true);
  expect(ask?.input.safeParse({ questions: [] }).success).toBe(false);
  expect(
    ask?.input.safeParse({ questions: Array(5).fill(question) }).success,
  ).toBe(false);
  expect(
    ask?.input.safeParse({ questions: [{ ...question, options: ["yes"] }] })
      .success,
  ).toBe(false);
  expect(
    ask?.input.safeParse({ questions: [question], extra: 1 }).success,
  ).toBe(false);
});

test("gate_submit is the one pending tool (M3 amendment h): listed nowhere, so never served", () => {
  expect(names(MCP_TOOLS.filter((t) => t.pending === true))).toEqual([
    "gate_submit",
  ]);
  const all = names(MCP_TOOLS);
  for (const role of McpRole.options) {
    expect(names(ok(toolsetFor(role, all)))).toEqual(
      ROLE_MATRIX[role].filter((wire) => wire !== "gate_submit"),
    );
  }
});

test("finding_resolve takes a finding and a 1-500 character note; the run comes from the caller", () => {
  const resolve = mcpTool("finding_resolve")?.input;
  const input = { finding: "F1", note: "fixed the null check" };
  expect(resolve?.safeParse(input).success).toBe(true);
  for (const bad of [
    { note: "" },
    { note: "n".repeat(501) },
    { run_id: "R1" },
    { finding: undefined },
  ]) {
    expect(resolve?.safeParse({ ...input, ...bad }).success).toBe(false);
  }
});

test("every hand-off accept refusal is one of the closed MCP refusal reasons", () => {
  for (const reason of AcceptRefusalReason.options) {
    expect(McpRefusalReason.options).toContain(reason);
  }
  expect(McpRefusalReason.options).toContain("not_writable");
});

test("every staffing refusal, cross_project among them, is one of the closed MCP refusal reasons", () => {
  for (const reason of StaffRefusalReason.options) {
    if (reason === "approval_pending") continue;
    expect(McpRefusalReason.options).toContain(reason);
  }
  expect(McpRefusalReason.options).toContain("cross_project");
});

test("approval_pending is a staffing outcome, never an MCP refusal: ticket_staff returns it as data", () => {
  expect(StaffRefusalReason.options).toContain("approval_pending");
  expect(McpRefusalReason.options).not.toContain("approval_pending");
});

// handoff_write's JSON schema as tools/list serves it: the bounds the model is shown and zod enforces.
const MaxLength = z.object({ maxLength: z.int() });
const Items = z.object({
  minItems: z.int().optional(),
  maxItems: z.int(),
  items: MaxLength,
});
const HandoffWriteSchema = z.object({
  properties: z.object({
    goal_line: MaxLength,
    decisions: Items,
    traps: Items,
    next_steps: Items,
    open_questions: Items,
    pointers: Items,
  }),
});

test("handoff_write's description and length hint state the bounds its served schema enforces", () => {
  const write = mcpTool("handoff_write") as McpTool;
  const p = HandoffWriteSchema.parse(toolJsonSchema(write)).properties;
  const item = p.decisions.items.maxLength;
  for (const list of [
    p.decisions,
    p.traps,
    p.next_steps,
    p.open_questions,
    p.pointers,
  ]) {
    expect(list.items.maxLength).toBe(item);
  }
  expect(p.next_steps.minItems).toBe(p.next_steps.maxItems);
  expect(write.description).toBe(
    `Write your hand-off's judgement. goal_line ≤${p.goal_line.maxLength} chars; ` +
      `decisions ≤${p.decisions.maxItems}, traps ≤${p.traps.maxItems}; ` +
      `next_steps exactly ${p.next_steps.maxItems}; open_questions ≤${p.open_questions.maxItems}; ` +
      `pointers ≤${p.pointers.maxItems}; every item ≤${item} chars, one point per item. ` +
      "Longer detail goes in a file in the worktree, with its path under pointers.",
  );
  expect(write.lengthHint).toBe(
    `Shorten each item to ${item} characters or fewer (goal_line ${p.goal_line.maxLength}). ` +
      "Put longer detail in a file and list its path under pointers.",
  );
  // The hint is a bad call's text, never served: tools/list, and so toolset_hash, is name, text, schema.
  expect(Object.keys(listedTools([write])[0] ?? {})).toEqual([
    "name",
    "description",
    "inputSchema",
  ]);
});

test("the hand-off bounds are App. D's and §7.2's, and do not move", () => {
  expect(HANDOFF_LIMITS).toEqual({
    goalLine: 200,
    decisions: 6,
    traps: 6,
    nextSteps: 3,
    openQuestions: 5,
    pointers: 10,
    item: 300,
  });
  // No other tool carries a length hint: their refusals stay as they were.
  expect(
    MCP_TOOLS.filter((t) => t.lengthHint !== undefined).map((t) => t.wire),
  ).toEqual(["handoff_write"]);
  // The refusal keeps its cap by cutting zod's text before the hint, so the hint stays short.
  for (const t of MCP_TOOLS)
    expect(t.lengthHint?.length ?? 0).toBeLessThan(500);
});

test("M2 inputs are bounded like the packet (≤6 decisions, ≤6 traps, exactly 3 next steps); pulse and session come from the token", () => {
  const write = mcpTool("handoff_write")?.input;
  const packet = {
    goal_line: "Make the transfer path idempotent.",
    decisions: ["guard in the service"],
    traps: [],
    next_steps: ["catch the violation", "fix the fixture", "re-run the tests"],
  };
  expect(write?.safeParse(packet).success).toBe(true);
  for (const bad of [
    { decisions: Array<string>(7).fill("d") },
    { traps: Array<string>(7).fill("t") },
    { next_steps: [] },
    { next_steps: ["1", "2"] },
    { next_steps: ["1", "2", "3", "4"] },
    { goal_line: "g".repeat(201) },
    { ticket: "T" },
  ]) {
    expect(write?.safeParse({ ...packet, ...bad }).success).toBe(false);
  }
  expect(mcpTool("handoff_read")?.input.safeParse({}).success).toBe(true);
  expect(mcpTool("handoff_accept")?.input.safeParse({}).success).toBe(true);
  const request = mcpTool("handoff_request")?.input;
  expect(request?.safeParse({ note: "out of depth" }).success).toBe(true);
  expect(request?.safeParse({}).success).toBe(true);
  // §7.1: agent_request is the only reason an agent gives; the model cannot name another.
  expect(request?.safeParse({ reason: "operator" }).success).toBe(false);

  const report = mcpTool("pulse_report")?.input;
  const summary = { summary_md: "Staffed one.", actions: ["staffed #12"] };
  expect(report?.safeParse(summary).success).toBe(true);
  expect(report?.safeParse({ ...summary, pulse_id: "P" }).success).toBe(false);
  expect(
    report?.safeParse({ ...summary, actions: Array<string>(21).fill("a") })
      .success,
  ).toBe(false);
  expect(
    mcpTool("probe_run")?.input.safeParse({ probe: "log_scan" }).success,
  ).toBe(true);
});

test("ticket_create takes an optional probe fingerprint of 1-64 characters", () => {
  const create = mcpTool("ticket_create")?.input;
  const ticket = { title: "log_scan: relaunch loop", type: "bug" };
  expect(create?.safeParse(ticket).success).toBe(true);
  expect(
    create?.safeParse({ ...ticket, fingerprint: "0123456789abcdef" }).success,
  ).toBe(true);
  for (const fingerprint of ["", "f".repeat(65), 7]) {
    expect(create?.safeParse({ ...ticket, fingerprint }).success).toBe(false);
  }
});

test("ticket_update takes an optional plan_path: POST /tickets' PlanPath, repo-relative", () => {
  const update = mcpTool("ticket_update")?.input;
  const submit = { ticket: "7", version: 3, status: "plan_review" };
  expect(update?.safeParse(submit).success).toBe(true);
  for (const plan_path of ["docs/spikes/T7.md", "PLAN.md"]) {
    expect(update?.safeParse({ ...submit, plan_path }).success).toBe(true);
  }
  for (const plan_path of [
    "/etc/plan.md",
    "../plan.md",
    "docs/../plan.md",
    "docs//plan.md",
    "docs\\plan.md",
    "p".repeat(257),
    7,
  ]) {
    expect(
      update?.safeParse({ ...submit, plan_path }).success,
      String(plan_path),
    ).toBe(false);
  }
  expect(toolJsonSchema(mcpTool("ticket_update") as McpTool)).toMatchObject({
    properties: { plan_path: { type: "string", maxLength: 256 } },
  });
});

test("conformance_echo is the conformance role's only tool, in no work role's row or shipped allowlist", () => {
  expect(McpRole.options).toEqual([...WORK_ROLES, "conformance"]);
  expect(ROLE_MATRIX.conformance).toEqual(["conformance_echo"]);
  const all = names(MCP_TOOLS);
  for (const role of WORK_ROLES) {
    expect(ROLE_MATRIX[role]).not.toContain("conformance_echo");
    expect(names(ok(toolsetFor(role, all)))).not.toContain("conformance_echo");
  }
  for (const allowlist of Object.values(SHIPPED_ALLOWLISTS)) {
    expect(allowlist).not.toContain("conformance_echo");
  }
  const echo = mcpTool("conformance_echo")?.input;
  expect(echo?.safeParse({ nonce: "frm-1" }).success).toBe(true);
  expect(echo?.safeParse({ nonce: "frm-1", extra: 1 }).success).toBe(false);
});
