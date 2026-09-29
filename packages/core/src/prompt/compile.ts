// The prompt compiler (§8.2, §8.3). Sections render in the template's fixed order; inputs are
// serialized stably (NFC, LF, sorted keys; no clock, no ids). The layout is cache-stable: the
// template body and the static and semi-static sections form a prefix that no volatile input can
// change, and the volatile sections follow one marker line at the end. Over-long sections are cut
// in the template's documented order, and every cut is recorded (`runs.truncated_sections_json`).
import { err, ok, type Result } from "../errors.js";
import { canonicalJson, type JsonValue } from "../hash/canonical-json.js";
import { hashPrompt, sha256Hex } from "../hash/hashes.js";
import { CHARS_PER_TOKEN, localTokens } from "./budget.js";
import {
  templateId,
  type PromptBlock,
  type PromptSection,
  type PromptTemplate,
} from "./templates.js";

/**
 * Inputs by section name. A string is markdown, used as is; any other JSON value renders as a
 * JSON block with sorted keys. undefined, null or blank leaves the section out.
 */
export type PromptInputs = Readonly<Record<string, JsonValue | undefined>>;

/** Opens the volatile block: everything after it may differ from run to run. */
export const VOLATILE_MARKER =
  "<!-- volatile: everything below changes from run to run -->";
/** Ends a cut section's body. */
export const TRUNCATION_MARKER = "\n[… truncated by foreman]";
/** The fewest characters a cut leaves: the marker plus one. */
const MIN_KEEP = TRUNCATION_MARKER.length + 1;

/** A rendered section (heading included) or the template body, in local tokens. */
export type SectionSize = {
  readonly name: string;
  readonly block: PromptBlock;
  readonly tokens: number;
};

/** One cut section. `tokens_after` 0: it was dropped. */
export type Truncation = {
  readonly section: string;
  readonly tokens_before: number;
  readonly tokens_after: number;
};

export type CompiledPrompt = {
  readonly templateId: string;
  /** The exact prompt: `prefix + volatile`. */
  readonly text: string;
  /** Every byte before the volatile block. No volatile input ever changes it, under any budget. */
  readonly prefix: string;
  /** The volatile block, marker included; "" when there is none. `context_hash` hashes it. */
  readonly volatile: string;
  /** The template body as `template`, then each rendered section, in order. */
  readonly sections: readonly SectionSize[];
  /** What was cut, in truncation order. */
  readonly truncated: readonly Truncation[];
};

export type CompileOptions = {
  /** The whole prompt's budget in local tokens (see promptBudget); 0 or absent: none. */
  readonly maxTokens?: number;
};

type Part = { readonly section: PromptSection; readonly body: string };

/**
 * Renders `inputs` through `template`. First each section with `max_tokens` is cut to it. Then,
 * while the prompt is over `maxTokens`, sections are cut in `truncation_order`: prefix sections
 * against the budget less the volatile block's largest size, then volatile sections against the
 * whole budget, so a prefix cut never depends on a volatile input (§8.3). A cut keeps the head and
 * ends with TRUNCATION_MARKER; an optional section too small to keep is dropped, a required one
 * keeps at least the marker. Pure: the same inputs give the same bytes.
 */
export function compile(
  template: PromptTemplate,
  inputs: PromptInputs,
  o: CompileOptions = {},
): Result<CompiledPrompt> {
  const parts = collect(template, inputs);
  if (!parts.ok) return parts;
  const capped = parts.value.map(capSection);
  const limit = (o.maxTokens ?? 0) * CHARS_PER_TOKEN;
  const fitted = limit > 0 ? fitTotal(template, capped, limit) : capped;
  const { prefix, volatile } = layout(template, fitted);
  return ok({
    templateId: templateId(template),
    text: prefix + volatile,
    prefix,
    volatile,
    sections: [
      {
        name: "template",
        block: "static",
        tokens: localTokens(normalize(template.body)),
      },
      ...fitted.map((p) => ({
        name: p.section.name,
        block: p.section.block,
        tokens: localTokens(chunk(p)),
      })),
    ],
    truncated: truncations(template, parts.value, fitted),
  });
}

/** `prompt_hash` over the exact text and `context_hash` over the volatile block (§8.1). */
export async function promptHashes(
  c: CompiledPrompt,
): Promise<{ readonly prompt_hash: string; readonly context_hash: string }> {
  return {
    prompt_hash: await hashPrompt(c.text),
    context_hash: await sha256Hex(c.volatile),
  };
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

function collect(t: PromptTemplate, inputs: PromptInputs): Result<Part[]> {
  const id = templateId(t);
  const unknown = Object.keys(inputs).filter(
    (key) => !t.sections.some((s) => s.name === key),
  );
  if (unknown.length > 0) {
    return invalid(
      `prompt ${id} has no section ${unknown.toSorted().join(", ")}`,
    );
  }
  const parts: Part[] = [];
  for (const section of t.sections) {
    const body = bodyOf(id, section, inputs[section.name]);
    if (!body.ok) return body;
    if (body.value !== "") parts.push({ section, body: body.value });
  }
  const missing = t.sections.filter(
    (s) => s.required && !parts.some((p) => p.section === s),
  );
  return missing.length > 0
    ? invalid(`prompt ${id} needs ${missing.map((s) => s.name).join(", ")}`)
    : ok(parts);
}

/**
 * One section's rendered body, "" when it is left out. A section with fixed `text` renders that
 * text; if the text carries `{{name}}` slots it is *filled* from its input instead, which must be
 * an object naming exactly those slots. That is how a sentence addressed to the model stays in the
 * versioned, hash-pinned template while the values in it vary (Invariant 8): a call site passes
 * data, never prose.
 */
function bodyOf(
  id: string,
  section: PromptSection,
  input: JsonValue | undefined,
): Result<string> {
  const { text, name } = section;
  if (text === undefined) return ok(render(input));
  const slots = slotsOf(text);
  if (slots.length === 0) {
    return input === undefined
      ? ok(render(text))
      : invalid(`prompt ${id} section ${name} is fixed: it takes no input`);
  }
  if (input === undefined || input === null) return ok("");
  const filled = fillSlots(text, slots, input);
  return filled === null
    ? invalid(
        `prompt ${id} section ${name} takes an object of ${slots.join(", ")}`,
      )
    : ok(normalize(filled));
}

/** A slot in a section's fixed text: `{{name}}`, filled from that section's input. */
const SLOT = /\{\{([a-z][a-z0-9_]*)\}\}/g;

const slotsOf = (text: string): string[] => [
  ...new Set([...text.matchAll(SLOT)].map(([, slot]) => slot as string)),
];

/**
 * `text` with every slot replaced by `input`'s value for it, escaped as any other input is; null
 * when `input` is not an object naming exactly `slots`, each a non-empty string. Filling here
 * rather than handing back a map keeps a slot that was never checked from reaching the prompt.
 */
function fillSlots(
  text: string,
  slots: readonly string[],
  input: JsonValue,
): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const given = new Map<string, JsonValue | undefined>(Object.entries(input));
  if (given.size !== slots.length) return null;
  let filled = text;
  for (const slot of slots) {
    const value = given.get(slot);
    if (typeof value !== "string" || normalize(value) === "") return null;
    filled = filled.replaceAll(`{{${slot}}}`, escapeSyntax(normalize(value)));
  }
  return filled;
}

/** NFC, LF line endings, no surrounding whitespace. */
const normalize = (text: string): string =>
  text.normalize("NFC").replace(/\r\n?/g, "\n").trim();

/**
 * Input text cannot forge the prompt's structure: its headings sink two levels, below a section's
 * `##`, and no HTML comment opener survives, so the volatile marker is only where layout puts it.
 */
const escapeSyntax = (text: string): string =>
  text.replace(/^( {0,3})#/gm, "$1###").replaceAll("<!--", "<\\!--");

function render(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return escapeSyntax(normalize(value));
  // A pretty JSON line never starts with `#`; `<` of a comment opener becomes <, still JSON.
  const sorted: unknown = JSON.parse(canonicalJson(value));
  const json = JSON.stringify(sorted, null, 2).replaceAll("<!--", "\\u003c!--");
  return `\`\`\`json\n${json}\n\`\`\``;
}

const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;

/** `body` in at most `maxChars` (≥ MIN_KEEP), marker included. Never splits a surrogate pair. */
function clip(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const end = maxChars - TRUNCATION_MARKER.length;
  const safe = isHighSurrogate(body.charCodeAt(end - 1)) ? end - 1 : end;
  return body.slice(0, safe) + TRUNCATION_MARKER;
}

const capSection = (p: Part): Part =>
  p.section.max_tokens === undefined
    ? p
    : { ...p, body: clip(p.body, p.section.max_tokens * CHARS_PER_TOKEN) };

/**
 * The most characters the volatile block can take, from the template alone: its marker, every
 * volatile section at its max_tokens and every fixed one whole. An uncapped volatile section
 * reserves only its heading; the second pass or pre-flight deals with its size.
 */
function volatileReserve(t: PromptTemplate): number {
  const moving = t.sections.filter((s) => s.block === "volatile");
  if (moving.length === 0) return 0;
  return moving.reduce(
    (n, section) =>
      n +
      `\n${chunk({ section, body: "" })}\n`.length +
      (section.text === undefined
        ? (section.max_tokens ?? 0) * CHARS_PER_TOKEN
        : render(section.text).length),
    `\n${VOLATILE_MARKER}\n`.length,
  );
}

/**
 * Fits the prompt into `limit` characters in two passes, so no volatile input can move a prefix
 * byte: prefix sections fit `limit` less the volatile reserve, then volatile sections fit `limit`.
 */
function fitTotal(
  t: PromptTemplate,
  parts: readonly Part[],
  limit: number,
): readonly Part[] {
  const prefixSize = (ps: readonly Part[]): number =>
    layout(t, ps).prefix.length;
  const totalSize = (ps: readonly Part[]): number => {
    const { prefix, volatile } = layout(t, ps);
    return prefix.length + volatile.length;
  };
  const stable = (p: Part): boolean => !isVolatile(p);
  const fitted = cutWithin(
    t,
    parts,
    stable,
    prefixSize,
    limit - volatileReserve(t),
  );
  return cutWithin(t, fitted, isVolatile, totalSize, limit);
}

/** Cuts the `which` sections in truncation order while `size` is over `limit`. */
function cutWithin(
  t: PromptTemplate,
  parts: readonly Part[],
  which: (p: Part) => boolean,
  size: (ps: readonly Part[]) => number,
  limit: number,
): readonly Part[] {
  return t.truncation_order.reduce((acc, name) => {
    const over = size(acc) - limit;
    const i = acc.findIndex((p) => p.section.name === name && which(p));
    const part = acc[i];
    if (over <= 0 || part === undefined) return acc;
    const keep = part.body.length - over;
    return keep < MIN_KEEP && !part.section.required
      ? acc.toSpliced(i, 1)
      : acc.with(i, {
          ...part,
          body: clip(part.body, Math.max(keep, MIN_KEEP)),
        });
  }, parts);
}

const chunk = (p: Part): string => `## ${p.section.heading}\n${p.body}`;
const isVolatile = (p: Part): boolean => p.section.block === "volatile";

/** Chunks one blank line apart, ending in one newline; the volatile block last, behind its marker. */
function layout(
  t: PromptTemplate,
  parts: readonly Part[],
): { readonly prefix: string; readonly volatile: string } {
  const stable = [
    normalize(t.body),
    ...parts.filter((p) => !isVolatile(p)).map(chunk),
  ];
  const moving = parts.filter(isVolatile).map(chunk);
  return {
    prefix: stable.map((c, i) => (i === 0 ? `${c}\n` : `\n${c}\n`)).join(""),
    volatile:
      moving.length === 0
        ? ""
        : [VOLATILE_MARKER, ...moving].map((c) => `\n${c}\n`).join(""),
  };
}

function truncations(
  t: PromptTemplate,
  before: readonly Part[],
  after: readonly Part[],
): Truncation[] {
  return t.truncation_order.flatMap((name) => {
    const was = before.find((p) => p.section.name === name);
    const now = after.find((p) => p.section.name === name);
    if (was === undefined || now?.body === was.body) return [];
    return [
      {
        section: name,
        tokens_before: localTokens(was.body),
        tokens_after: now === undefined ? 0 : localTokens(now.body),
      },
    ];
  });
}
