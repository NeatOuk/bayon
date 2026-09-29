/** A JSON value. Object members that are `undefined` are dropped, as JSON.stringify drops them. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] =>
  Array.isArray(value);

/**
 * Deterministic JSON for hashing. It has no whitespace, and keys and strings are normalized to
 * NFC. Object members are ordered by their serialized form, so key order never matters; arrays
 * keep their order. Primitives serialize exactly as JSON.stringify serializes them. Once hashes
 * are recorded this rule is permanent.
 */
export function canonicalJson(value: JsonValue): string {
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const members = Object.entries(value).flatMap(([key, member]) =>
    member === undefined
      ? []
      : [`${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(member)}`],
  );
  return `{${members.toSorted().join(",")}}`;
}
