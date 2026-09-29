import type { RunRow, SpendRow } from "@bayon/db";

// Pure checks. Each returns what is wrong, as sentences; an empty list passes.

/** The first of `expected` missing from `kinds` as an ordered subsequence, or undefined. */
export function missingFromSequence(
  kinds: readonly string[],
  expected: readonly string[],
): string | undefined {
  let from = 0;
  for (const kind of expected) {
    const at = kinds.indexOf(kind, from);
    if (at === -1) return kind;
    from = at + 1;
  }
  return undefined;
}

/**
 * Ids a cursor client received, against the ids stored: every stored id exactly once, in
 * increasing order, and nothing else.
 */
export function cursorProblems(
  received: readonly number[],
  stored: readonly number[],
): string[] {
  const duplicated = received.filter((id, i) => received.indexOf(id) !== i);
  const unordered = received.filter(
    (id, i) => i > 0 && id <= (received[i - 1] ?? 0),
  );
  const got = new Set(received);
  const want = new Set(stored);
  const gaps = stored.filter((id) => !got.has(id));
  const extra = received.filter((id) => !want.has(id));
  return [
    ...(duplicated.length > 0
      ? [`duplicated ids ${duplicated.join(", ")}`]
      : []),
    ...(unordered.length > 0
      ? [`ids out of order at ${unordered.join(", ")}`]
      : []),
    ...(gaps.length > 0 ? [`gap: ids ${gaps.join(", ")} never received`] : []),
    ...(extra.length > 0
      ? [`ids ${extra.join(", ")} received but not stored`]
      : []),
  ];
}

/** The §8.1 input hashes a run records (writes them all for run 1). */
export const RUN_HASHES = [
  "prompt_hash",
  "context_hash",
  "mission_hash",
  "doctrine_hash",
  "toolset_hash",
  "config_hash",
] as const;
const RUN_CHECKED = [
  ...RUN_HASHES,
  "model",
  "base_sha",
  "template_id",
] as const;
export type RunExpectations = Partial<
  Record<(typeof RUN_CHECKED)[number], string>
>;

/** Every §8.1 hash and the model recorded, and each expected value matched. */
export function runProblems(run: RunRow, expected: RunExpectations): string[] {
  const missing = [...RUN_HASHES, "model" as const].filter(
    (column) => run[column] === null || run[column] === "",
  );
  const wrong = RUN_CHECKED.flatMap((column) => {
    const want = expected[column];
    return want === undefined ||
      run[column] === want ||
      missing.includes(column as never)
      ? []
      : [`${column} is ${String(run[column])}, expected ${want}`];
  });
  return [
    ...missing.map((column) => `run ${run.id} recorded no ${column}`),
    ...wrong.map((problem) => `run ${run.id}: ${problem}`),
  ];
}

/** At least one spend row with tokens. */
export function spendProblems(rows: readonly SpendRow[]): string[] {
  if (rows.length === 0) return ["no spend row"];
  return rows.some((row) => row.tokens_in + row.tokens_out > 0)
    ? []
    : [`${rows.length} spend row(s), all with zero tokens`];
}
