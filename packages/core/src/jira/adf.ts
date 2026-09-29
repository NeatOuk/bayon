import { z } from "zod";

// Atlassian Document Format (a Jira issue's description in REST v3) into Markdown.
// Pure. ADF is recursive and arrives from outside, so it is parsed loosely: every field `.catch`es
// to a neutral value, a node that is not an object becomes an empty one, and the renderer never
// throws. A node it does not know falls back to the text of its descendants, so nothing written in
// Jira is lost, only its formatting.
//
// Depth is capped before anything recursive sees the document: a subtree deeper than
// ADF_MAX_DEPTH is folded into one text node holding its text, found by an explicit-stack walk. So
// neither the schema's recursive parse nor the renderer ever goes deeper than the cap, however deep
// the issue's description is nested; its deepest text is kept.

interface AdfMark {
  type: string;
  attrs: Record<string, unknown>;
}

/** One node as parsed: every field present, whatever arrived (the schema's shape). */
export interface AdfNode {
  type: string;
  text?: string | undefined;
  attrs: Record<string, unknown>;
  marks: AdfMark[];
  content: AdfNode[];
}

/** Past this many levels a subtree is its text alone: every recursion below is bounded by it. */
export const ADF_MAX_DEPTH = 64;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A node's plain text: its own `text`, else its descendants', concatenated in order. Walked with an
 * explicit stack, so no depth overflows it; a node met twice (a cyclic object) is read once.
 */
function flatText(root: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    if (typeof node.text === "string") {
      out.push(node.text);
    } else if (Array.isArray(node.content)) {
      for (let i = node.content.length - 1; i >= 0; i -= 1)
        stack.push(node.content[i]);
    }
  }
  return out.join("");
}

/**
 * `raw` with every subtree at ADF_MAX_DEPTH folded into a text node of its text: a new value, the
 * input untouched. Its own recursion stops at the cap.
 */
function capDepth(raw: unknown, depth = 0): unknown {
  if (!isRecord(raw)) return raw;
  if (depth >= ADF_MAX_DEPTH) return { type: "text", text: flatText(raw) };
  const content = raw.content;
  return Array.isArray(content)
    ? { ...raw, content: content.map((c: unknown) => capDepth(c, depth + 1)) }
    : raw;
}

/** A node that is not an object: it renders as nothing, and its siblings are kept. */
const empty = (): AdfNode => ({ type: "", attrs: {}, marks: [], content: [] });

const Attrs = z.record(z.string(), z.unknown()).catch({});
const Mark = z.object({ type: z.string(), attrs: Attrs });

export const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z
    .object({
      type: z.string().catch(""),
      text: z.string().optional().catch(undefined),
      attrs: Attrs,
      marks: z.array(Mark).catch([]),
      content: z.array(AdfNodeSchema).catch([]),
    })
    .catch(empty),
);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Only links a reader can follow safely; ` ()<>` are escaped so the Markdown stays whole. */
function safeUrl(value: unknown): string | undefined {
  const url = text(value);
  if (url === undefined || !/^(?:https?:|mailto:)/i.test(url)) return undefined;
  return url.replace(
    /[\s()<>]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** A node's plain text: its own, else its descendants', concatenated. */
const textOf = (node: AdfNode): string => flatText(node);

const blocks = (nodes: readonly AdfNode[], separator = "\n\n"): string =>
  nodes
    .map(render)
    .filter((s) => s !== "")
    .join(separator);

const inline = (nodes: readonly AdfNode[]): string =>
  nodes.map(render).join("");

/** `first` before the first line, `rest` before every other non-empty one. */
const indent = (body: string, first: string, rest: string): string =>
  body
    .split("\n")
    .map((line, i) => (i === 0 ? first + line : line === "" ? "" : rest + line))
    .join("\n");

function codeSpan(code: string): string {
  return code.includes("`") ? `\`\` ${code} \`\`` : `\`${code}\``;
}

/** Marks wrap the text inside its surrounding spaces, where Markdown can see them. */
function marked(value: string, marks: readonly AdfMark[]): string {
  const core = value.trim();
  if (core === "") return value;
  const lead = value.slice(0, value.length - value.trimStart().length);
  const trail = value.slice(value.trimEnd().length);
  const has = (type: string) => marks.find((m) => m.type === type);
  let out = has("code") === undefined ? core : codeSpan(core);
  if (has("strike") !== undefined) out = `~~${out}~~`;
  if (has("em") !== undefined) out = `*${out}*`;
  if (has("strong") !== undefined) out = `**${out}**`;
  const href = safeUrl(has("link")?.attrs.href);
  if (href !== undefined) out = `[${out}](${href})`;
  return `${lead}${out}${trail}`;
}

function headingLevel(value: unknown): number {
  const level = Number(value);
  return Number.isInteger(level) ? Math.min(6, Math.max(1, level)) : 1;
}

function list(items: readonly AdfNode[], marker: (i: number) => string) {
  return items
    .map((item, i) => {
      const m = marker(i);
      return indent(render(item), m, " ".repeat(m.length));
    })
    .join("\n");
}

function orderedStart(value: unknown): number {
  const start = Number(value);
  return Number.isInteger(start) && start >= 0 ? start : 1;
}

function fence(node: AdfNode): string {
  const code = textOf(node);
  const longest = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${text(node.attrs.language) ?? ""}\n${code}\n${ticks}`;
}

const quote = (body: string): string =>
  body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

function mention(attrs: Record<string, unknown>): string {
  const name = text(attrs.text) ?? text(attrs.id) ?? "";
  return name.startsWith("@") ? name : `@${name}`;
}

function card(node: AdfNode): string {
  const url = safeUrl(node.attrs.url);
  return url === undefined ? textOf(node) : `<${url}>`;
}

/** A cell on one line: its blocks joined by `<br>`, its pipes escaped. */
const cell = (node: AdfNode): string =>
  blocks(node.content, "\n").replaceAll("|", "\\|").replaceAll("\n", "<br>");

function table(node: AdfNode): string {
  const rows = node.content.map((row) => row.content.map(cell));
  const [head, ...rest] = rows;
  if (head === undefined) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [
    line(head),
    line(Array.from({ length: width }, () => "---")),
    ...rest.map(line),
  ].join("\n");
}

function expand(node: AdfNode): string {
  const title = text(node.attrs.title);
  const body = blocks(node.content);
  if (title === undefined) return body;
  return body === "" ? `**${title}**` : `**${title}**\n\n${body}`;
}

/** A `date` node's day, from its epoch-millis `timestamp`. */
function day(value: unknown): string {
  const ms = Number(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
    ? new Date(ms).toISOString().slice(0, 10)
    : "";
}

function render(node: AdfNode): string {
  switch (node.type) {
    case "doc":
    case "panel":
      return blocks(node.content);
    case "paragraph":
      return inline(node.content);
    case "heading":
      return `${"#".repeat(headingLevel(node.attrs.level))} ${inline(node.content)}`;
    case "text":
      return marked(node.text ?? "", node.marks);
    case "hardBreak":
      return "  \n";
    case "bulletList":
      return list(node.content, () => "- ");
    case "orderedList": {
      const start = orderedStart(node.attrs.order);
      return list(node.content, (i) => `${start + i}. `);
    }
    case "listItem":
      return blocks(node.content, "\n");
    case "codeBlock":
      return fence(node);
    case "blockquote":
      return quote(blocks(node.content));
    case "rule":
      return "---";
    case "mention":
      return mention(node.attrs);
    case "emoji":
      return text(node.attrs.text) ?? text(node.attrs.shortName) ?? "";
    case "inlineCard":
    case "blockCard":
      return card(node);
    case "table":
      return table(node);
    case "expand":
    case "nestedExpand":
      return expand(node);
    case "status":
      return text(node.attrs.text) ?? "";
    case "date":
      return day(node.attrs.timestamp);
    default:
      return textOf(node);
  }
}

/**
 * A description as Markdown. Null or absent is "", a string (REST v2's plain text) is itself, and
 * anything else is read as an ADF document.
 */
export function adfToMarkdown(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return doc.trim();
  return render(AdfNodeSchema.parse(capDepth(doc))).trim();
}
