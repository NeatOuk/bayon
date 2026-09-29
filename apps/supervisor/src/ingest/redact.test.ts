// Invariant 11: a runner's children inherit its env, so a secret can surface in
// any stdout record. Ingest redacts before the raw-log append, so nothing downstream sees it.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  MIN_HEAD,
  MIN_REDACT_LENGTH,
  REDACTED,
  createRedactor,
  createStreamRedactor,
} from "./redact.js";

/** No 8-or-more-character run of `value` survives in `text`, marker or not. */
function hasNoWindowOf(text: string, value: string): void {
  for (let n = 0; n + MIN_HEAD <= value.length; n += 1) {
    expect(text).not.toContain(value.slice(n, n + MIN_HEAD));
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ab"; // base64url, like a minted token

test("every occurrence of a value is replaced, and a JSON line stays valid", () => {
  const line = JSON.stringify({
    type: "user",
    text: `FRM_MCP_TOKEN=${TOKEN}\nagain: ${TOKEN}`,
  });
  const out = dec(createRedactor([TOKEN])(enc(line), false));
  expect(out).not.toContain(TOKEN);
  expect(JSON.parse(out)).toEqual({
    type: "user",
    text: `FRM_MCP_TOKEN=${REDACTED}\nagain: ${REDACTED}`,
  });
});

test("a value is also matched in its JSON-escaped form", () => {
  const secret = 'pa"ss\\word/0123456789';
  const line = JSON.stringify({ text: `secret=${secret}` });
  const out = dec(createRedactor([secret])(enc(line), false));
  expect(out).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(JSON.parse(out)).toEqual({ text: `secret=${REDACTED}` });
});

test("several values are all redacted", () => {
  const other = "sk-other-secret-value-0123456789";
  const out = dec(
    createRedactor([TOKEN, other])(enc(`${other} and ${TOKEN}`), false),
  );
  expect(out).toBe(`${REDACTED} and ${REDACTED}`);
});

test(`values shorter than ${MIN_REDACT_LENGTH} characters are left alone: too likely in plain text`, () => {
  const bytes = enc("user=admin");
  expect(createRedactor(["admin"])(bytes, false)).toBe(bytes);
});

test("with nothing to redact, the record passes through untouched", () => {
  const bytes = enc('{"type":"assistant"}');
  expect(createRedactor([TOKEN])(bytes, false)).toBe(bytes);
  expect(createRedactor([])(bytes, false)).toBe(bytes);
});

test("a partial record cut inside a value has the value's head redacted", () => {
  const cut = `{"text":"env: ${TOKEN.slice(0, 20)}`;
  const out = dec(createRedactor([TOKEN])(enc(cut), true));
  expect(out).toBe(`{"text":"env: ${REDACTED}`);
});

test("a head shorter than 8 characters, or at the end of a complete record, stays", () => {
  const short = `{"text":"${TOKEN.slice(0, 7)}`;
  expect(dec(createRedactor([TOKEN])(enc(short), true))).toBe(short);
  const complete = `tail ${TOKEN.slice(0, 20)}`;
  expect(dec(createRedactor([TOKEN])(enc(complete), false))).toBe(complete);
});

// createStreamRedactor: the takeover pty log (FRM-123), a live text stream rather than discrete
// records — a value can be split by an arbitrary onData chunk boundary, or by tmux's own line
// wrapping, which need not even split it at a chunk boundary.

test("a value whole inside one chunk is redacted", () => {
  const r = createStreamRedactor([TOKEN]);
  const out = r.push(`before ${TOKEN} after`) + r.end();
  expect(out).toBe(`before ${REDACTED} after`);
  expect(out).not.toContain(TOKEN);
});

test("a value split across two chunks, at every split point, never survives whole or in pieces", () => {
  for (let at = 1; at < TOKEN.length; at += 1) {
    const r = createStreamRedactor([TOKEN]);
    const p1 = r.push(`env: ${TOKEN.slice(0, at)}`);
    const p2 = r.push(`${TOKEN.slice(at)} :end`);
    const out = p1 + p2 + r.end();
    hasNoWindowOf(out, TOKEN);
    expect(out).toBe(`env: ${REDACTED} :end`);
  }
});

// A credential file of the kind a granted login holds: tokens under keys, pretty-printed, so it
// carries eight-space indentation, ordinary JSON keys and plain words as long as a token (16 or
// more characters) as well as its secrets.
const REFRESH = "rt_0123456789abcdefghijklmnopqrstuvwxyzABCDEF";
const LOGIN = JSON.stringify(
  {
    oauth: {
      accessToken: TOKEN,
      refreshToken: REFRESH,
      expiresAt: 1759000000000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "enterprise_standard",
    },
  },
  null,
  4,
);

test("a credential file's keys, words, indentation and punctuation are not secrets: scrollback that shares them is untouched", () => {
  const scrollback = [
    "{",
    '        "accessToken": "a different value",',
    '        "expiresAt": 1759000000000,',
    '        "scopes": ["user:inference", "user:profile"],',
    '        "subscriptionType": "a different plan"',
    "}",
    "const refreshToken = await renew(expiresAt);",
    "see the description of the enterprise standard plan",
    "",
  ].join("\r\n");
  const r = createStreamRedactor([LOGIN]);
  expect(r.push(scrollback) + r.end()).toBe(scrollback);
});

test("a credential file's tokens are still caught on their own, whole or wrapped, and the whole file is one marker", () => {
  const r = createStreamRedactor([LOGIN]);
  const wrapped = `${REFRESH.slice(0, 20)}\r\n\x1b[3;1H${REFRESH.slice(20)}`;
  const out =
    r.push(`token: ${TOKEN}\r\n${wrapped}\r\nfile: ${LOGIN}\r\n`) + r.end();
  hasNoWindowOf(out, TOKEN);
  hasNoWindowOf(out, REFRESH);
  expect(out).toBe(
    `token: ${REDACTED}\r\n${REDACTED}\r\n\x1b[3;1H${REDACTED}\r\nfile: ${REDACTED}\r\n`,
  );
});

test("a whole multi-field value split across two chunks, at every split point, is one marker, short fields and all", () => {
  for (let at = 1; at < LOGIN.length; at += 1) {
    const r = createStreamRedactor([LOGIN]);
    const p1 = r.push(`before ${LOGIN.slice(0, at)}`);
    const p2 = r.push(`${LOGIN.slice(at)} after`);
    expect(p1 + p2 + r.end()).toBe(`before ${REDACTED} after`);
  }
});

test("a value with no field break is a token whatever its characters: a digitless one is still caught wrapped", () => {
  const value = "correct-horse-battery-staple-lantern";
  const rows = [value.slice(0, 15), value.slice(15, 30), value.slice(30)];
  const r = createStreamRedactor([value]);
  const out = r.push(rows.join("\r\n\x1b[2;1H")) + r.end();
  hasNoWindowOf(out, value);
  expect(out).toBe(
    `${REDACTED}\r\n\x1b[2;1H${REDACTED}\r\n\x1b[2;1H${rows[2]}`,
  );
});

test("a long value costs each chunk a scan of that chunk, never a rescan of the value", () => {
  // 17 KB, one field, no repeats: larger than any credential file. Checking every suffix length of
  // each chunk against it, as a naive carry does, is billions of comparisons over the chunks below;
  // one scan of each chunk is a million window lookups, well inside the test's timeout.
  const value = Array.from({ length: 400 }, (_, i) =>
    createHash("sha256").update(`${i}`).digest("base64url"),
  ).join("");
  const chunk = "lorem ipsum dolor sit amet, ".repeat(147);
  const r = createStreamRedactor([value]);
  let out = "";
  for (let n = 0; n < 256; n += 1) out += r.push(chunk);
  out += r.push(`then ${value} :end`) + r.end();
  expect(out).toBe(`${chunk.repeat(256)}then ${REDACTED} :end`);
});

test("a value broken the way a pane wrap breaks it never survives in a run of 8 or more", () => {
  // tmux redrawing an 80-column pane inserts a CRLF and a cursor-position escape between rows; a
  // long value lands in the file as several pieces, not one contiguous run.
  const rows = [TOKEN.slice(0, 15), TOKEN.slice(15, 30), TOKEN.slice(30)];
  const wrapped = rows.join("\r\n\x1b[2;1H");
  const r = createStreamRedactor([TOKEN]);
  const out = r.push(wrapped) + r.end();
  hasNoWindowOf(out, TOKEN);
  expect(out).toContain(REDACTED);
});

test("text that merely begins like a value is released, not eaten", () => {
  const r = createStreamRedactor([TOKEN]);
  const p1 = r.push(`prefix ${TOKEN.slice(0, 4)}`);
  const p2 = r.push("unrelated text that never completes the value");
  expect(p1 + p2 + r.end()).toBe(
    `prefix ${TOKEN.slice(0, 4)}unrelated text that never completes the value`,
  );
});

test("no values, or values shorter than MIN_REDACT_LENGTH, is the identity", () => {
  const r1 = createStreamRedactor([]);
  expect(r1.push("hello world")).toBe("hello world");
  expect(r1.end()).toBe("");

  const r2 = createStreamRedactor(["short"]);
  expect(r2.push("user=short")).toBe("user=short");
  expect(r2.end()).toBe("");
});

test("a run cut short by the chunk's own end, not the needle's, is held rather than closed off", () => {
  // TOKEN's match in chunk 1 runs out because the chunk does, not because TOKEN does: naively
  // closing it off there (as if the run were complete) leaves the leftover < MIN_HEAD characters
  // of TOKEN in chunk 2 too short for that chunk's own window scan, so they surface raw right next
  // to the marker for the same value — the value's own end, still recoverable a piece at a time.
  const at = TOKEN.length - 5;
  const r = createStreamRedactor([TOKEN]);
  const p1 = r.push(TOKEN.slice(0, at));
  const p2 = r.push(`${TOKEN.slice(at)} :end`);
  const out = p1 + p2 + r.end();
  expect(out).toBe(`${REDACTED} :end`);
  expect(out).not.toContain(TOKEN.slice(at));
});

test("a chunk's end is held only when it could start a run of a value: ordinary text is released at once", () => {
  const r = createStreamRedactor([TOKEN]);
  // No character of "done" occurs in TOKEN, so no next chunk can make it part of a run.
  expect(r.push("build done")).toBe("build done");
  // "WXYZ" does occur in TOKEN, mid-value: held, and caught once the next chunk makes it a run.
  expect(r.push(" see WXYZ")).toBe(" see ");
  expect(r.push("0123456789 end") + r.end()).toBe(`${REDACTED} end`);
});

test("a tail held back takes an unfinished escape sequence with it: the file never ends inside one", () => {
  // A watcher that attaches while a tail is held replays the file, then gets live bytes from there
  // on (pty-hub.ts): a file ending in `ESC [3;` would have the watcher's parser swallow them.
  const r = createStreamRedactor([TOKEN]);
  // "H" occurs in TOKEN, so it is held — and the CSI it ends goes with it, not cut in two.
  expect(r.push("prompt \x1b[3;1H")).toBe("prompt ");
  expect(r.push("ok\r\n")).toBe("\x1b[3;1Hok\r\n");
  // A string sequence (an OSC title) the same, up to its BEL.
  expect(r.push("\x1b]0;build 1")).toBe("");
  expect(r.push("\x07ok\r\n")).toBe("\x1b]0;build 1\x07ok\r\n");
  // A finished sequence before a held tail stays released.
  expect(r.push("\x1b[0mA")).toBe("\x1b[0m");
  // With nothing held, the file is exactly the stream so far, so a sequence open at the chunk's end
  // is released: the next live bytes finish it for a watcher and the file alike.
  expect(r.push("\r\n\x1b[3;")).toBe("A\r\n\x1b[3;");
  expect(r.end()).toBe("");
});

test("a surrogate pair at a chunk end is held or released whole, never cut in two", () => {
  // A value holding an astral character: every one of its pieces feeds the carry, lone low
  // surrogate included, so a different character sharing that low surrogate ends a chunk.
  const value = "sk-😀-0123456789abcdef";
  const linearA = "\u{10600}"; // U+D801 U+DE00; the value's emoji is U+D83D U+DE00
  const r = createStreamRedactor([value]);
  const p1 = r.push(`look: ${linearA}`);
  const p2 = r.push(" ok");
  const p3 = r.end();
  for (const p of [p1, p2, p3]) expect(p.isWellFormed()).toBe(true);
  expect(p1 + p2 + p3).toBe(`look: ${linearA} ok`);
});

test("end() flushes a tail held at the stream's close", () => {
  const r = createStreamRedactor([TOKEN]);
  const p1 = r.push(`tail: ${TOKEN.slice(0, TOKEN.length - 2)}`);
  const p2 = r.end();
  const out = p1 + p2;
  hasNoWindowOf(out, TOKEN);
  expect(out).toContain(REDACTED);
});
