// The structured-output check. ACP's session/prompt takes no schema, so the
// turn host validates the final answer itself before it writes SendSpec.output.path. The check is
// plain JS kept as source text: the host runs it inlined (`node -e`, nothing shipped), and this
// module compiles the same text for the adapter and the tests, so both run one implementation.
// A schema with a keyword it does not check is refused before the turn, never half-checked.

/** Keywords that constrain a value; the check implements each of them. */
export const CHECKED_KEYWORDS: readonly string[] = [
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "allOf",
];

/** Keywords that only annotate: ignored by any validator. */
export const ANNOTATIONS: readonly string[] = [
  "$schema",
  "$id",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
];

/**
 * `unsupportedKeywords(schema)` → the keywords, anywhere in the schema, the check cannot enforce.
 * `checkValue(schema, value)` → the list of issues; empty when the value is valid.
 * `parseAnswer(text)` → `{ ok, value }` from a final answer, one surrounding code fence allowed.
 */
export const SCHEMA_CHECK_SOURCE = `
const CHECKED = ${JSON.stringify(CHECKED_KEYWORDS)};
const ANNOTATION = ${JSON.stringify(ANNOTATIONS)};
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function unsupportedKeywords(schema) {
  const found = new Set();
  const walk = (s) => {
    if (typeof s === "boolean") return;
    if (!isObject(s)) {
      found.add("(not a schema)");
      return;
    }
    for (const key of Object.keys(s)) {
      if (!CHECKED.includes(key) && !ANNOTATION.includes(key)) found.add(key);
    }
    if (isObject(s.properties)) for (const p of Object.values(s.properties)) walk(p);
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") walk(s.additionalProperties);
    if (s.items !== undefined) walk(s.items);
    for (const k of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(s[k])) for (const sub of s[k]) walk(sub);
  };
  walk(schema);
  return [...found].sort();
}
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}
function typeMatches(v, want) {
  const got = typeOf(v);
  return got === want || (want === "number" && got === "integer");
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function checkValue(schema, value, at) {
  const path = at || "$";
  if (schema === true) return [];
  if (schema === false) return [path + ": no value is allowed"];
  const issues = [];
  const s = schema;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(value, t))) return [path + ": expected " + types.join(" or ") + ", got " + typeOf(value)];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => same(e, value))) issues.push(path + ": not one of " + JSON.stringify(s.enum));
  if (s.const !== undefined && !same(s.const, value)) issues.push(path + ": must be " + JSON.stringify(s.const));
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) issues.push(path + ": shorter than " + s.minLength);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) issues.push(path + ": longer than " + s.maxLength);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) issues.push(path + ": below " + s.minimum);
    if (typeof s.maximum === "number" && value > s.maximum) issues.push(path + ": above " + s.maximum);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) issues.push(path + ": fewer than " + s.minItems + " items");
    if (typeof s.maxItems === "number" && value.length > s.maxItems) issues.push(path + ": more than " + s.maxItems + " items");
    if (s.items !== undefined) value.forEach((item, i) => issues.push(...checkValue(s.items, item, path + "[" + i + "]")));
  }
  if (isObject(value)) {
    const props = isObject(s.properties) ? s.properties : {};
    for (const key of Array.isArray(s.required) ? s.required : []) {
      if (!Object.hasOwn(value, key)) issues.push(path + ": missing " + key);
    }
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) issues.push(...checkValue(props[key], v, path + "." + key));
      else if (s.additionalProperties === false) issues.push(path + ": unexpected " + key);
      else if (isObject(s.additionalProperties)) issues.push(...checkValue(s.additionalProperties, v, path + "." + key));
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) issues.push(...checkValue(sub, value, path));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((sub) => checkValue(sub, value, path).length === 0)) issues.push(path + ": matches none of anyOf");
  if (Array.isArray(s.oneOf) && s.oneOf.filter((sub) => checkValue(sub, value, path).length === 0).length !== 1) issues.push(path + ": must match exactly one of oneOf");
  return issues;
}
function parseAnswer(text) {
  let t = String(text).trim();
  const fence = /^\\\`\\\`\\\`[a-zA-Z]*\\n([\\s\\S]*?)\\n?\\\`\\\`\\\`$/.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, value: undefined };
  }
}
`;

type Check = {
  readonly unsupportedKeywords: (schema: unknown) => string[];
  readonly checkValue: (schema: unknown, value: unknown) => string[];
  readonly parseAnswer: (text: string) => { ok: boolean; value: unknown };
};

// The same text the host inlines, compiled once here. The source is this module's own constant.
const compiled = new Function(
  `${SCHEMA_CHECK_SOURCE}\nreturn { unsupportedKeywords, checkValue, parseAnswer };`,
)() as Check;

export const unsupportedKeywords = (schema: unknown): string[] =>
  compiled.unsupportedKeywords(schema);
export const checkValue = (schema: unknown, value: unknown): string[] =>
  compiled.checkValue(schema, value);
export const parseAnswer = (text: string): { ok: boolean; value: unknown } =>
  compiled.parseAnswer(text);
