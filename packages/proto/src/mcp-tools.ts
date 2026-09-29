// The MCP tool catalogue (§11.1 as amended by M1 amendments 1 and 2). One
// source for the API's tools/list and tools/call and for the supervisor's toolset_hash, so what a
// model is shown is byte-for-byte what its session's hash covers.
import {
  StaffRefusalReason,
  WORK_ROLES,
  err,
  ok,
  type JsonValue,
  type Result,
  type ToolDefinition,
} from "@bayon/core";
import { z } from "zod";
import { PulseReportPayload } from "./commands.js";
import { PlanPath } from "./tickets.js";

/**
 * The roles that do work (§11.1), from core: `executors.untrusted_roles` is a list of these and
 * core's schema is what refuses a value that is not one, so the list cannot live here — proto
 * depends on core. Re-exported so the MCP catalogue's callers keep one import.
 */
export { WORK_ROLES };

/**
 * Conformance test 11 (§15): a role that is no work role, holding only
 * conformance_echo. The API serves it to a conformance probe's token alone.
 */
export const CONFORMANCE_ROLE = "conformance";

/** Every role an MCP token can hold: the work roles, and the conformance probe's. */
export const McpRole = z.enum([...WORK_ROLES, CONFORMANCE_ROLE]);
export type McpRole = z.infer<typeof McpRole>;
export const CONFORMANCE_ECHO_TOOL = "conformance_echo";
/** The echo's audit row: target_kind this, target_id the nonce. The supervisor's probe reads it. */
export const CONFORMANCE_NONCE_TARGET = "conformance_nonce";

export interface McpToolCap {
  /** Rows a list tool returns at most; the rest is behind `next_cursor`. */
  readonly rows?: number;
  readonly bytes: number;
  readonly lines: number;
}

export interface McpTool<I extends z.ZodObject = z.ZodObject> {
  /** The name on the wire (amendment 2). */
  readonly wire: string;
  /** The spec's dotted name, for display only. */
  readonly specName: string;
  readonly roles: readonly McpRole[];
  readonly description: string;
  readonly input: I;
  readonly cap: McpToolCap;
  /** Writes something, so it is audited and scoped (§6, §7). */
  readonly write: boolean;
  /** Catalogued but not wired yet: in no tool set, so never listed; a call is refused. */
  readonly pending?: boolean;
  /**
   * The line a bad call's text adds when a string argument is too long: how to fit.
   * Never in tools/list, so not in toolset_hash.
   */
  readonly lengthHint?: string;
}

/** §8.5's backstop: 8 KB and 200 lines, whatever the tool. */
export const MCP_RESULT_CAP = { bytes: 8 * 1024, lines: 200 } as const;
/** List tools page at 20 rows (§8.5). */
export const MCP_PAGE_ROWS = 20;
/** The widest body window a read tool returns in one call. */
export const MCP_BODY_WINDOW = 4096;
/** The most documentation pages one doc_search returns; its default is MCP_PAGE_ROWS. */
export const DOC_SEARCH_MAX = 20;

const ALL = WORK_ROLES;
const NOT_ORCH = ["builder", "reviewer", "investigator"] as const;

// Bounds live in the schemas, so the model sees them and zod enforces them. Integers always get
// explicit bounds: a bare z.int() serializes the safe-integer range, which costs tokens.
const id = z.string().max(64);
const text = (max: number) => z.string().max(max);
const offset = z.int().min(0).max(100_000_000).optional();
const limit = z.int().min(1).max(MCP_BODY_WINDOW).optional();
const cursor = z.string().max(64).optional();

const list: McpToolCap = { rows: MCP_PAGE_ROWS, ...MCP_RESULT_CAP };
const single: McpToolCap = MCP_RESULT_CAP;

/**
 * handoff_write's bounds: App. D's packet (≤6 decisions, ≤6 traps, the next 3 steps) and §7.2's
 * one-line goal. Its schema, description and length hint are all built from these, so what the
 * model is told cannot drift from what zod enforces.
 */
export const HANDOFF_LIMITS = {
  goalLine: 200,
  decisions: 6,
  traps: 6,
  nextSteps: 3,
  openQuestions: 5,
  pointers: 10,
  /** Every list item. */
  item: 300,
} as const;
const H = HANDOFF_LIMITS;

function tool<I extends z.ZodObject>(
  wire: string,
  roles: readonly McpRole[],
  description: string,
  input: I,
  o: {
    readonly write: boolean;
    readonly cap?: McpToolCap;
    readonly pending?: boolean;
    readonly lengthHint?: string;
  },
): McpTool<I> {
  return {
    wire,
    specName: wire.replace("_", "."),
    roles,
    description,
    input,
    cap: o.cap ?? single,
    write: o.write,
    ...(o.pending === true ? { pending: true } : {}),
    ...(o.lengthHint === undefined ? {} : { lengthHint: o.lengthHint }),
  };
}

/** Each tool's input by wire name: typed for the API's handlers, serialized for tools/list. */
export const MCP_INPUTS = {
  ticket_search: z.strictObject({
    q: text(200),
    status: text(32).optional(),
    cursor,
  }),
  ticket_get: z.strictObject({ ticket: id, offset, limit }),
  ticket_create: z.strictObject({
    title: text(200),
    type: z.enum(["bug", "feature", "chore", "docs", "spike", "followup"]),
    body_md: text(8000).optional(),
    parent: id.optional(),
    /** A probe finding's fingerprint (§10.2): origin probe, and a repeat returns the first ticket. */
    fingerprint: z.string().min(1).max(64).optional(),
  }),
  ticket_update: z.strictObject({
    ticket: id,
    version: z.int().min(1).max(1_000_000_000),
    status: text(32).optional(),
    title: text(200).optional(),
    body_md: text(8000).optional(),
    reason: text(500).optional(),
    blocked_reason: text(500).optional(),
    unblock_condition: text(500).optional(),
    /** POST /tickets' PlanPath; with status plan_review it submits the plan. */
    plan_path: PlanPath.optional(),
  }),
  ticket_comment: z.strictObject({ ticket: id, body_md: text(4000) }),
  ticket_link: z.strictObject({
    ticket: id,
    to: id,
    kind: z.enum(["blocks", "relates", "duplicates", "followup"]),
  }),
  // `agent`: an agent id of the ticket's project, in place of the selection rule's.
  ticket_staff: z.strictObject({
    ticket: id,
    role: z.enum(NOT_ORCH),
    agent: id.min(1).optional(),
  }),
  mission_read: z.strictObject({ offset, limit }),
  mailbox_send: z.strictObject({
    to: id,
    subject: text(200),
    body_md: text(4000),
  }),
  mailbox_inbox: z.strictObject({
    unread_only: z.boolean().optional(),
    cursor,
  }),
  // M2 hand-off tools (§7, §11.1; App. D): the packet's judgement half, bounded like the packet.
  handoff_write: z.strictObject({
    goal_line: text(H.goalLine),
    decisions: z.array(text(H.item)).max(H.decisions),
    traps: z.array(text(H.item)).max(H.traps),
    next_steps: z.array(text(H.item)).length(H.nextSteps),
    open_questions: z.array(text(H.item)).max(H.openQuestions).optional(),
    pointers: z.array(text(H.item)).max(H.pointers).optional(),
  }),
  handoff_read: z.strictObject({ id: id.optional(), ticket: id.optional() }),
  handoff_accept: z.strictObject({ id: id.optional() }),
  // The reason is always agent_request (§7.1: the only trigger an agent initiates); the why is the note.
  handoff_request: z.strictObject({ note: text(500).optional() }),
  memory_search: z.strictObject({ q: text(200), cursor }),
  memory_append: z.strictObject({
    kind: z.enum(["trap", "rule", "fact", "howto"]),
    title: text(200),
    body_md: text(4000),
  }),
  human_ask: z.strictObject({
    questions: z
      .array(
        z.strictObject({
          question: text(500),
          options: z.array(text(120)).min(2).max(5),
          recommendation: text(120).optional(),
        }),
      )
      .min(1)
      .max(4),
    ticket: id.optional(),
  }),
  // M2 pulse tools: the pulse and session come from the caller's token, never from the model.
  pulse_report: z.strictObject(
    PulseReportPayload.pick({ summary_md: true, actions: true }).shape,
  ),
  probe_run: z.strictObject({ probe: id }),
  artifact_attach: z.strictObject({
    kind: z.enum(["pr", "doc", "file", "url"]),
    ref: text(500),
    note: text(200).optional(),
  }),
  // M3: the fixing run is the caller's open run, never named by the model.
  finding_resolve: z.strictObject({
    finding: id,
    note: z.string().min(1).max(500),
  }),
  // Catalogued, not wired (M3 amendment h): reviewers emit structured output and the daemon decides.
  gate_submit: z.strictObject({}),
  // M7.6: the project's documentation, read-only. The project comes from the caller's
  // token, never from the model; `space` must be one the project allows.
  doc_search: z.strictObject({
    q: text(200),
    space: z.string().max(50).optional(),
    limit: z.int().min(1).max(DOC_SEARCH_MAX).optional(),
  }),
  doc_get: z.strictObject({ ref: text(500) }),
  // M3: conformance test 11 only.
  conformance_echo: z.strictObject({ nonce: z.string().min(1).max(64) }),
} as const;

const I = MCP_INPUTS;

export const MCP_TOOLS: readonly McpTool[] = [
  tool(
    "ticket_search",
    ALL,
    "Find tickets by text: 20 rows, fields only.",
    I.ticket_search,
    {
      write: false,
      cap: list,
    },
  ),
  tool(
    "ticket_get",
    ALL,
    "One ticket: windowed body, recent events, human answers.",
    I.ticket_get,
    {
      write: false,
    },
  ),
  tool("ticket_create", ALL, "File a ticket.", I.ticket_create, {
    write: true,
  }),
  tool(
    "ticket_update",
    ["orchestrator", "builder"],
    "Update your ticket; version is compare-and-set. plan_path with status plan_review submits your plan.",
    I.ticket_update,
    { write: true },
  ),
  tool("ticket_comment", ALL, "Comment on your ticket.", I.ticket_comment, {
    write: true,
  }),
  tool("ticket_link", ALL, "Link your ticket to another.", I.ticket_link, {
    write: true,
  }),
  tool(
    "ticket_staff",
    ["orchestrator"],
    "Staff a ticket: spawn a session on it.",
    I.ticket_staff,
    // The run class comes from the status; the agent from the selection rule, among the ticket's
    // project's agents, unless one is named (M2 amendment h).
    { write: true },
  ),
  tool("mission_read", ALL, "Your mission, windowed.", I.mission_read, {
    write: false,
  }),
  tool("mailbox_send", ALL, "Send an async note to an agent.", I.mailbox_send, {
    write: true,
  }),
  tool(
    "mailbox_inbox",
    ALL,
    "Your messages: 20 rows, bodies windowed.",
    I.mailbox_inbox,
    {
      write: false,
      cap: list,
    },
  ),
  // M2 hand-off tools: the caller's own row and ticket, found by its session.
  // Its bounds in words: the schema's maxLength alone left agents writing long items.
  tool(
    "handoff_write",
    ALL,
    `Write your hand-off's judgement. goal_line ≤${H.goalLine} chars; ` +
      `decisions ≤${H.decisions}, traps ≤${H.traps}; next_steps exactly ${H.nextSteps}; ` +
      `open_questions ≤${H.openQuestions}; pointers ≤${H.pointers}; ` +
      `every item ≤${H.item} chars, one point per item. ` +
      "Longer detail goes in a file in the worktree, with its path under pointers.",
    I.handoff_write,
    {
      write: true,
      lengthHint:
        `Shorten each item to ${H.item} characters or fewer (goal_line ${H.goalLine}). ` +
        "Put longer detail in a file and list its path under pointers.",
    },
  ),
  tool(
    "handoff_read",
    ALL,
    "Read a hand-off packet by id, or a ticket's latest.",
    I.handoff_read,
    { write: false },
  ),
  tool(
    "handoff_accept",
    ALL,
    "Accept your hand-off; you then own its ticket.",
    I.handoff_accept,
    { write: true },
  ),
  tool(
    "handoff_request",
    ALL,
    "Ask to hand off: stuck, out of depth or too big.",
    I.handoff_request,
    { write: true },
  ),
  tool(
    "memory_search",
    ALL,
    "Search shared knowledge: 20 rows.",
    I.memory_search,
    {
      write: false,
      cap: list,
    },
  ),
  tool("memory_append", ALL, "Propose a knowledge entry.", I.memory_append, {
    write: true,
  }),
  tool(
    "human_ask",
    ALL,
    "Ask the operator; returns at once. Answers show in ticket_get.",
    I.human_ask,
    { write: true },
  ),
  tool(
    "pulse_report",
    ["orchestrator"],
    "Report this pulse: summary and actions. Call it before you finish.",
    I.pulse_report,
    { write: true },
  ),
  tool(
    "probe_run",
    ["orchestrator"],
    "Re-run one probe for this pulse.",
    I.probe_run,
    { write: true },
  ),
  tool(
    "artifact_attach",
    ALL,
    "Attach a PR URL or doc path to your ticket.",
    I.artifact_attach,
    {
      write: true,
    },
  ),
  tool(
    "finding_resolve",
    ["builder"],
    "Mark a review finding on your ticket fixed; your current run is the fix.",
    I.finding_resolve,
    { write: true },
  ),
  tool(
    "gate_submit",
    ["reviewer"],
    "Submit a gate's findings and evidence.",
    I.gate_submit,
    { write: true, pending: true },
  ),
  // M7.6: read-only, and refused rather than failed when the project has no source.
  tool(
    "doc_search",
    ALL,
    "Search this project's documentation: title, space, link and an excerpt.",
    I.doc_search,
    { write: false, cap: list },
  ),
  tool(
    "doc_get",
    ALL,
    "Read one documentation page as Markdown, by id or by its link.",
    I.doc_get,
    { write: false },
  ),
  // Conformance only: recorded as an audit row, which is how the probe sees the call.
  tool(
    CONFORMANCE_ECHO_TOOL,
    [CONFORMANCE_ROLE],
    "Conformance probe: returns its arguments.",
    I.conformance_echo,
    { write: true },
  ),
];

const BY_WIRE: ReadonlyMap<string, McpTool> = new Map(
  MCP_TOOLS.map((t) => [t.wire, t]),
);

export const mcpTool = (wire: string): McpTool | undefined => BY_WIRE.get(wire);

const rowOf = (role: McpRole): readonly string[] =>
  MCP_TOOLS.filter((t) => t.roles.includes(role)).map((t) => t.wire);

/** §11.1 as data: each role's tools, in catalogue order. */
export const ROLE_MATRIX: Readonly<Record<McpRole, readonly string[]>> = {
  orchestrator: rowOf("orchestrator"),
  builder: rowOf("builder"),
  reviewer: rowOf("reviewer"),
  investigator: rowOf("investigator"),
  conformance: rowOf("conformance"),
};

/**
 * The allowlists seeded into the shipped profiles (amendment 1; M2 contracts): builder 13 (M3 adds
 * finding_resolve, M7.6 the two doc tools), reviewer 7, each with the hand-off tools it needs. The
 * orchestrator's is what a pulse needs — it staffs and does not build, so it reads the
 * docs through the tickets it files, not itself. All three stay under §8.6's 1.5k; no role's whole
 * row does.
 */
export const SHIPPED_ALLOWLISTS = {
  orchestrator: [
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
  ],
  builder: [
    "ticket_get",
    "ticket_update",
    "ticket_comment",
    "ticket_create",
    "artifact_attach",
    "memory_append",
    "human_ask",
    "handoff_write",
    "handoff_accept",
    "handoff_request",
    "finding_resolve",
    "doc_search",
    "doc_get",
  ],
  reviewer: [
    "ticket_get",
    "ticket_comment",
    "human_ask",
    "handoff_write",
    "handoff_accept",
    "doc_search",
    "doc_get",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * A session's tools: its role's matrix row intersected with the profile's allowlist, in catalogue
 * order. A role outside the matrix gets none; an allowlist entry that names no tool is refused.
 */
export function toolsetFor(
  role: string,
  allowlist: readonly unknown[],
): Result<readonly McpTool[]> {
  const unknown = allowlist.filter(
    (entry) => typeof entry !== "string" || !BY_WIRE.has(entry),
  );
  if (unknown.length > 0) {
    return err({
      class: "validation",
      message: `the tool allowlist names no MCP tool: ${unknown.map((e) => JSON.stringify(e)).join(", ")}`,
      retryable: false,
    });
  }
  const parsed = McpRole.safeParse(role);
  if (!parsed.success) return ok([]);
  const allowed = new Set(allowlist);
  return ok(
    MCP_TOOLS.filter(
      (t) =>
        t.pending !== true &&
        t.roles.includes(parsed.data) &&
        allowed.has(t.wire),
    ),
  );
}

/**
 * Every tool a session can be served, by wire name (the pending ones are in no tool set): the
 * allowlist `frm config apply` gives a profile that names none, so its role's row decides.
 */
export const CATALOGUE_TOOLS: readonly string[] = MCP_TOOLS.filter(
  (t) => t.pending !== true,
).map((t) => t.wire);

/**
 * The tools a work role can be served at all: its row of the catalogue, pending ones out. Empty for
 * a role that is no work role (conformance, qa, util). Admission's `no_tools` reads it.
 */
export function workRoleTools(role: string): readonly McpTool[] {
  if (!(WORK_ROLES as readonly string[]).includes(role)) return [];
  const row = toolsetFor(role, CATALOGUE_TOOLS);
  return row.ok ? row.value : [];
}

export type JsonObject = { readonly [key: string]: JsonValue };
const JsonObjectSchema = z.record(z.string(), z.json());

const schemas = new WeakMap<McpTool, JsonObject>();

/** The tool's input as JSON Schema, without `$schema` (it costs tokens and says nothing). */
export function toolJsonSchema(t: McpTool): JsonObject {
  const cached = schemas.get(t);
  if (cached !== undefined) return cached;
  const entries = Object.entries(z.toJSONSchema(t.input)).filter(
    ([key]) => key !== "$schema",
  );
  const schema: JsonObject = JsonObjectSchema.parse(
    Object.fromEntries(entries),
  );
  schemas.set(t, schema);
  return schema;
}

/** One entry of tools/list. */
export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export const listedTools = (tools: readonly McpTool[]): ListedTool[] =>
  tools.map((t) => ({
    name: t.wire,
    description: t.description,
    inputSchema: toolJsonSchema(t),
  }));

/** What `hashToolset` hashes: exactly the tools/list payload, per tool. */
export const toolDefinitions = (tools: readonly McpTool[]): ToolDefinition[] =>
  listedTools(tools).map((t) => ({
    name: t.name,
    schema: { description: t.description, input: t.inputSchema },
  }));

/** Why a tool call was refused (contract 4): a closed set, machine-readable; the §3.2 laws' finer
 * reasons map onto it (apps/api mcp/refusals.ts); staffing's and the hand-off's are their own (M2). */
export const McpRefusalReason = z.enum([
  "illegal_transition",
  "cross_ticket_write",
  "missing_evidence",
  "unresolved_findings",
  "actor_not_allowed",
  "version_conflict",
  "not_found",
  // Staffing's own reasons, `cross_project` among them: every ticket tool of an orchestrator with a
  // project refuses a ticket outside it with that reason too. `approval_pending` is not
  // one: ticket_staff returns a proposal as data (StaffProposed), never as a refusal.
  ...StaffRefusalReason.exclude(["approval_pending"]).options,
  /** handoff_write outside handoff_writing: the hand-off is sealed, or was never requested. */
  "not_writable",
  /** handoff_accept on a row still being written, or accepted by another session. */
  "not_pending",
  /** handoff_accept with no id: the ticket is owned, closed, or has a hand-off to accept. */
  "not_claimable",
]);
export type McpRefusalReason = z.infer<typeof McpRefusalReason>;
