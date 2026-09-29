// FTS5's default tokenizer (unicode61) keeps letters, numbers and private-use characters.
const TOKEN_CHAR = /[\p{L}\p{N}\p{Co}]/u;

/**
 * Plain words as an FTS5 query: each whitespace-separated word becomes a quoted phrase, and a row
 * must match every one. User text is never FTS5 syntax (column filters, OR, NEAR, `*`). null when
 * no word holds a token, since such a query matches nothing.
 */
export function ftsQuery(text: string): string | null {
  const phrases = text
    .split(/\s+/)
    .filter((word) => TOKEN_CHAR.test(word))
    .map((word) => `"${word.replaceAll('"', '""')}"`);
  return phrases.length === 0 ? null : phrases.join(" ");
}

const WORD = /[\p{L}\p{N}\p{Co}]+/gu;
/** Shorter words ("a", "of", "to") match nearly every row, so they are not searched. */
const MIN_WORD = 3;

/**
 * Any word of `texts` as an FTS5 query: the first `maxWords` distinct words of three characters or
 * more, lowercased, in the order met, each a quoted phrase, joined by OR. A word holds token
 * characters only, so it needs no escaping. null when there is none.
 */
export function ftsAnyQuery(
  texts: readonly string[],
  maxWords: number,
): string | null {
  const words = [
    ...new Set(
      texts
        .flatMap((text) => text.toLowerCase().match(WORD) ?? [])
        .filter((word) => word.length >= MIN_WORD),
    ),
  ].slice(0, maxWords);
  return words.length === 0
    ? null
    : words.map((word) => `"${word}"`).join(" OR ");
}
