// "Did you mean …": the known word closest to a typo, by edit distance, or by prefix when the typo
// is the start of one ("root" for "roots"). Nothing when every word is too far to be the one meant.

/**
 * Edit distance with adjacent transpositions (optimal string alignment): an insertion, a deletion,
 * a substitution or two neighbours swapped ("yse" for "yes") each cost one.
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  const at = (i: number, j: number): number => d[i]?.[j] ?? 0;
  for (let i = 1; i <= a.length; i++) {
    const row = d[i] ?? [];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        at(i - 1, j) + 1,
        at(i, j - 1) + 1,
        at(i - 1, j - 1) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, at(i - 2, j - 2) + 1);
      row[j] = best;
    }
  }
  return at(a.length, b.length);
}

/** How far a typo may be from the word meant: one edit, two once it is 4 characters or more. */
const limitFor = (typed: string): number => (typed.length >= 4 ? 2 : 1);

/**
 * The closest of `words` to `typed`, or null when none is near enough to suggest. Options are
 * matched without their `--` (pass both bare): the dashes would count toward the length.
 */
export function closest(
  typed: string,
  words: readonly string[],
): string | null {
  const prefixed = words.find((w) => typed.length >= 3 && w.startsWith(typed));
  if (prefixed !== undefined) return prefixed;
  const limit = limitFor(typed);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const word of words) {
    const d = editDistance(typed, word);
    if (d <= limit && d < bestDistance) {
      best = word;
      bestDistance = d;
    }
  }
  return best;
}
