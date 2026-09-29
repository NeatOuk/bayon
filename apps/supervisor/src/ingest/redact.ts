// Invariant 11: a runner's children inherit its env, so a secret the supervisor
// injected (the MCP token, the resolved secrets) can surface in any stdout record — an `env` dump in
// a tool result. Ingest redacts each record before the raw-log append, so the raw log, events,
// spill files, error messages and replay only ever hold redacted bytes.

export const REDACTED = "[redacted]";
/** Shorter values are too likely to occur in ordinary text; every minted token is far longer. */
export const MIN_REDACT_LENGTH = 16;
/** The shortest head of a value that a partial record's tail is redacted for, and the shortest run
 * of a value's field that the stream redactor (below) ever replaces. */
export const MIN_HEAD = 8;

/** Redacts one record; returns `bytes` itself when nothing matched. */
export type Redactor = (bytes: Uint8Array, partial: boolean) => Uint8Array;

const REPLACEMENT = Buffer.from(REDACTED, "utf8");

function replaceAll(buf: Buffer, needle: Buffer): Buffer {
  const parts: Buffer[] = [];
  let from = 0;
  for (
    let at = buf.indexOf(needle);
    at !== -1;
    at = buf.indexOf(needle, from)
  ) {
    parts.push(buf.subarray(from, at), REPLACEMENT);
    from = at + needle.length;
  }
  parts.push(buf.subarray(from));
  return Buffer.concat(parts);
}

/** A record cut off by EOF may end inside a value: redact that head too. */
function redactHead(
  buf: Buffer,
  needles: readonly Buffer[],
): Buffer | undefined {
  for (const needle of needles) {
    for (
      let n = Math.min(needle.length - 1, buf.length);
      n >= MIN_HEAD;
      n -= 1
    ) {
      if (buf.subarray(buf.length - n).equals(needle.subarray(0, n))) {
        return Buffer.concat([buf.subarray(0, buf.length - n), REPLACEMENT]);
      }
    }
  }
  return undefined;
}

// A stdout record is JSON, so a value with quotes or backslashes appears escaped. Longest first, so
// an escaped form is never half-replaced by a shorter needle. Shared with the stream redactor below
// — one place that decides what a secret looks like in bytes.
function needlesOf(values: readonly string[]): string[] {
  const forms = values
    .filter((v) => v.length >= MIN_REDACT_LENGTH)
    .flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]);
  return [...new Set(forms)].toSorted((a, b) => b.length - a.length);
}

export function createRedactor(values: readonly string[]): Redactor {
  const needles = needlesOf(values).map((v) => Buffer.from(v, "utf8"));
  if (needles.length === 0) return (bytes) => bytes;
  return (bytes, partial) => {
    let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let changed = false;
    for (const needle of needles) {
      if (buf.indexOf(needle) === -1) continue;
      buf = replaceAll(buf, needle);
      changed = true;
    }
    const cut = partial ? redactHead(buf, needles) : undefined;
    if (cut !== undefined) return cut;
    return changed ? buf : bytes;
  };
}

/** Where a structured value — a JSON or TOML credential file, an env file, a PEM block — breaks
 * between its fields: whitespace, quotes, backslashes, brackets and key/value punctuation. None of
 * them occurs inside a token (base64, base64url, hex, a JWT, a UUID), so a token is one field. */
const FIELD_BREAK = /[\s"'`\\()[\]{}<>,:;=]/u;

/** What the stream redactor matches runs of. A value with no field break is a token, its own one
 * field, whatever characters it holds. A structured value's fields are its tokens, never its keys,
 * indentation, punctuation or words, which ordinary scrollback shares all the time (eight spaces, a
 * JSON key like `subscriptionType`, whose `scription` would take a piece out of `description`): only
 * a field at least `MIN_REDACT_LENGTH` long holding a letter and a digit, as a token or a base64 line
 * of a key does. The rest is left to the whole-value match alone. A word-like field that does hold a
 * digit (`default_plan_20x`) still feeds, which costs a marker in scrollback that shares a run of it,
 * never a secret. */
function fieldsOf(needles: readonly string[]): string[] {
  const fields = needles.flatMap((v) =>
    FIELD_BREAK.test(v)
      ? v
          .split(FIELD_BREAK)
          .filter(
            (f) =>
              f.length >= MIN_REDACT_LENGTH &&
              /\d/u.test(f) &&
              /\p{L}/u.test(f),
          )
      : [v],
  );
  return [...new Set(fields)];
}

/** The fields, indexed two ways. `windows`: every `MIN_HEAD`-length window of every field, keyed by
 * its text, so a run can be found by a lookup wherever it starts inside the field — a wrapped
 * terminal line or a chunk boundary cuts a value at an arbitrary offset, not just its start (unlike a
 * cut stdout record, which always ends inside a value's own prefix). `pieces`: every shorter
 * substring of every field — what a chunk's last few characters must be for the next chunk to be
 * able to complete a run that starts in them. */
type Window = { field: string; offset: number };
type FieldIndex = { windows: Map<string, Window[]>; pieces: Set<string> };

function indexFields(fields: readonly string[]): FieldIndex {
  const windows = new Map<string, Window[]>();
  const pieces = new Set<string>();
  for (const field of fields) {
    for (let offset = 0; offset < field.length; offset += 1) {
      for (let n = 1; n < MIN_HEAD && offset + n <= field.length; n += 1)
        pieces.add(field.slice(offset, offset + n));
      if (offset + MIN_HEAD > field.length) continue;
      const key = field.slice(offset, offset + MIN_HEAD);
      const at = windows.get(key);
      if (at) at.push({ field, offset });
      else windows.set(key, [{ field, offset }]);
    }
  }
  return { windows, pieces };
}

/** How far back a release point looks for an escape sequence left open. Every CSI, and every
 * ordinary OSC (a title, a hyperlink), is far shorter; one longer is released as it stands, so a
 * sequence that never finishes is never held for good. */
const MAX_ESCAPE = 256;

/** Moves a release point `cut` in `text` back, never past `from`, off anything a terminal parser
 * would see cut in two: an escape sequence opened in the last `MAX_ESCAPE` characters and not yet
 * finished (CSI; OSC, DCS and the other strings, ended by BEL or ST; the short ESC forms), or a
 * surrogate pair. What is held back is late for the file, and a watcher that attaches meanwhile
 * never sees it at all (`pty-hub.ts` replays the file, then goes live) — so the file must end where
 * the watcher's parser is at rest: missing a cursor move, never holding half of one that swallows
 * the live bytes after it, and never a lone surrogate the file's UTF-8 turns into U+FFFD. */
function settle(text: string, from: number, cut: number): number {
  let state: "ground" | "esc" | "csi" | "string" = "ground";
  let open = cut;
  for (let i = Math.max(from, cut - MAX_ESCAPE); i < cut; i += 1) {
    const ch = text.charAt(i);
    if (state === "string") {
      // BEL ends it; so does ST, ESC `\`, which the `esc` state finishes as a short ESC form.
      if (ch === "\x07") state = "ground";
      else if (ch === "\x1b") state = "esc";
    } else if (ch === "\x1b") {
      state = "esc";
      open = i;
    } else if (state === "esc") {
      if (ch === "[") state = "csi";
      else if ("]PX^_".includes(ch)) state = "string";
      // An intermediate byte keeps it open; a final byte, or anything else, ends it.
      else if (ch < " " || ch > "/") state = "ground";
    } else if (state === "csi" && (ch < " " || ch > "?")) {
      state = "ground"; // past its parameter and intermediate bytes: a final byte ends it
    }
  }
  let at = state === "ground" ? cut : open;
  const last = text.charCodeAt(at - 1);
  if (at > from && last >= 0xd800 && last <= 0xdbff) at -= 1;
  return at;
}

/** The longest suffix of `text.slice(from, stop)` shorter than `MIN_HEAD` that occurs inside some
 * field. A substring of a field has every suffix inside one too, so the first length that is not
 * ends the search. */
function pieceTail(
  text: string,
  from: number,
  stop: number,
  pieces: ReadonlySet<string>,
): number {
  const most = Math.min(MIN_HEAD - 1, stop - from);
  let n = 0;
  while (n < most && pieces.has(text.slice(stop - n - 1, stop))) n += 1;
  return n;
}

/** Replaces every maximal run of `>= MIN_HEAD` characters of `text` that occurs inside some field,
 * at any offset, with `REDACTED`. Two adjacent runs of the same value can come out as two markers
 * rather than one; the value is still nowhere in the output, which is all this guarantees.
 *
 * Unless `final`, the end of `text` that more chunk data could still extend into a run is `held`
 * rather than released:
 * - the last `head` characters, a whole value's head the caller has already found (`headTail`);
 * - before them, a run that reaches all the way to the head — `text` ran out, not the field, and
 *   marking it now would let the leftover tail of the same secret arrive at the start of the next
 *   chunk too short (`< MIN_HEAD`) for that chunk's own window scan to catch on its own;
 * - otherwise the last few (`< MIN_HEAD`) characters, when they occur inside a field.
 * Nothing longer can need holding: a suffix of `MIN_HEAD` or more that occurs inside a field is a
 * run this scan has already found, the second case. So the carry costs nothing past the scan itself,
 * and is never longer than the longest field — plus, when anything is held, the start of an escape
 * sequence or a surrogate pair that the release point would otherwise cut (`settle`). `end()`
 * passes `final: true` (and `head` 0) — there is no next chunk, so a run cut short by `text`'s end
 * is still redacted. */
function redactRuns(
  text: string,
  index: FieldIndex,
  head: number,
  final: boolean,
): { done: string; held: string } {
  const stop = text.length - head;
  const parts: string[] = [];
  let from = 0;
  let cut = stop;
  let i = 0;
  while (i <= stop - MIN_HEAD) {
    const hits = index.windows.get(text.slice(i, i + MIN_HEAD));
    if (hits === undefined) {
      i += 1;
      continue;
    }
    let run = MIN_HEAD;
    for (const { field, offset } of hits) {
      const max = Math.min(field.length - offset, stop - i);
      let n = MIN_HEAD;
      while (n < max && text[i + n] === field[offset + n]) n += 1;
      if (n > run) run = n;
    }
    if (!final && i + run === stop) {
      cut = i;
      break;
    }
    parts.push(text.slice(from, i), REDACTED);
    i += run;
    from = i;
  }
  if (!final) {
    if (cut === stop) cut -= pieceTail(text, from, stop, index.pieces);
    if (cut < text.length) cut = settle(text, from, cut);
  }
  parts.push(text.slice(from, cut));
  return { done: parts.join(""), held: text.slice(cut) };
}

/** A whole value with its KMP failure table: `fail[i]` is the length of the longest proper prefix of
 * `needle.slice(0, i + 1)` that is also a suffix of it. */
type Head = { needle: string; fail: readonly number[] };

function headOf(needle: string): Head {
  const fail = [0];
  for (let i = 1, k = 0; i < needle.length; i += 1) {
    while (k > 0 && needle[i] !== needle[k]) k = fail[k - 1] ?? 0;
    if (needle[i] === needle[k]) k += 1;
    fail.push(k);
  }
  return { needle, fail };
}

/** The longest suffix of `text` that is a proper prefix of some whole value — one the next chunk may
 * yet complete, so it is held whole rather than released or cut into fields: the stream's form of a
 * partial record's head. One KMP pass per value over at most that value's length of `text`, so a
 * chunk costs its own length, never the square of a value's. */
function headTail(text: string, heads: readonly Head[]): number {
  let best = 0;
  for (const { needle, fail } of heads) {
    // One character short of the value's length: the scan cannot complete a match (every whole
    // occurrence is already replaced), so `k` ends as exactly the longest proper-prefix suffix.
    let k = 0;
    for (
      let i = Math.max(0, text.length - needle.length + 1);
      i < text.length;
      i += 1
    ) {
      while (k > 0 && text[i] !== needle[k]) k = fail[k - 1] ?? 0;
      if (text[i] === needle[k]) k += 1;
    }
    if (k > best) best = k;
  }
  return best;
}

/** A push/end pair that redacts a live text stream, not discrete records: the ring-buffer scrollback
 * of a takeover's pty (`pty-relay.ts`), where a secret can be split across an `onData` chunk boundary
 * or split across terminal rows by tmux's own line wrapping — a value need not even arrive
 * contiguously. Each value is replaced whole wherever it arrives in one piece, as a record's is, and
 * every run of `MIN_HEAD` or more of one of its fields wherever it does not. `push` may hold back a
 * tail between calls — a value's head, or the end of a run, never cut inside an escape sequence or a
 * surrogate pair — and `end()` flushes it. Every takeover's list holds at least its MCP token, so
 * that tail is routine: a chunk's last few characters are often held until the next chunk or
 * `end()`, late for the file but never lost. With no values to redact both are the identity. */
export function createStreamRedactor(values: readonly string[]): {
  push(chunk: string): string;
  end(): string;
} {
  const needles = needlesOf(values);
  if (needles.length === 0) return { push: (chunk) => chunk, end: () => "" };
  const heads = needles.map(headOf);
  const index = indexFields(fieldsOf(needles));
  const whole = (text: string): string =>
    needles.reduce((t, needle) => t.replaceAll(needle, REDACTED), text);
  let held = "";
  return {
    push(chunk) {
      const text = whole(held + chunk);
      const runs = redactRuns(text, index, headTail(text, heads), false);
      held = runs.held;
      return runs.done;
    },
    end() {
      const text = whole(held);
      held = "";
      // A stream that ends inside a value has that head redacted, as a record cut off by EOF does.
      const head = headTail(text, heads);
      if (head < MIN_HEAD) return redactRuns(text, index, 0, true).done;
      const body = text.slice(0, text.length - head);
      return redactRuns(body, index, 0, true).done + REDACTED;
    },
  };
}
