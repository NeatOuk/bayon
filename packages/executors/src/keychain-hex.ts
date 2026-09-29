// Reading a value back out of the macOS Keychain. `security find-generic-password -w`
// prints a value it cannot print literally — one holding a newline, a control byte or any non-ASCII
// byte — as a bare run of hex digits: no `0x`, no quoting, nothing in the output saying which form
// it is. So a multi-line secret — a runner's whole auth.json, say — reaches the child hex-encoded
// and silently breaks auth. Undoing that is a heuristic; it lives here, narrow, in one place.
import { err, ok, type Result } from "@bayon/core";
import { frmError } from "./errors.js";

/** A run of hex digits is the only shape `security` ever prints for a value it cannot show. */
const HEX = /^[0-9a-fA-F]+$/;

/** What `security` can print literally: printable US-ASCII, space included. */
const isPrintableAscii = (byte: number): boolean =>
  byte >= 0x20 && byte <= 0x7e;

/** Control characters that belong to text, and so to a legitimate multi-line secret. */
const TEXT_CONTROL = new Set([0x09, 0x0a, 0x0d]);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A character a text secret may hold: anything but a control character that is not tab/LF/CR. */
const isTextChar = (code: number): boolean =>
  TEXT_CONTROL.has(code) || (code >= 0x20 && code !== 0x7f);

/**
 * The printed value, decoded when — and only when — it is `security`'s hex form.
 *
 * Detection has to be narrow, because a legitimate secret can itself be a run of hex characters.
 * Four gates, in order:
 *
 * 1. **Even length and hex digits only.** The hex form is always byte pairs; odd length, or one
 *    non-hex character, means a literal value (and `Buffer.from(…, "hex")` would truncate it).
 * 2. **Some byte is not printable ASCII.** If every decoded byte were printable, `security` would
 *    have printed those characters literally rather than hex, so the hex form cannot be what we are
 *    holding: a short literal such as `6162` stays `6162` and never becomes `ab`.
 * 3. **The bytes are valid UTF-8.** This is the gate that protects real keys: a legitimate
 *    32-hex-character API key decodes to 16 bytes of binary, which is almost never valid UTF-8, so
 *    it fails here and falls through to the literal path unchanged. Anything that is not text could
 *    not have been a text secret anyway, so falling through costs nothing.
 * 4. **The text holds no control characters but tab, LF and CR.** Passing gates 1-3 with, say, a NUL
 *    in the middle means this really is the hex form (gate 2 said the bytes are not printable) but
 *    of something that is not usable text. That is refused loudly rather than handed to a runner.
 *
 * The residual ambiguity is gates 1-4 accepting a literal value that happens to be hex-shaped *and*
 * to decode to text containing a newline (`0a4142` → "\nAB"). Nothing in `security`'s output can
 * separate those two readings; storing secrets single-line (README §5) keeps you out of it.
 *
 * `name` only ever names the secret: a value never reaches a message (§14).
 */
export function decodeKeychainValue(
  name: string,
  printed: string,
): Result<string> {
  if (printed.length % 2 !== 0 || !HEX.test(printed)) return ok(printed);
  const bytes = Buffer.from(printed, "hex");
  if (bytes.every(isPrintableAscii)) return ok(printed);
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return ok(printed);
  }
  for (const ch of text) {
    if (!isTextChar(ch.codePointAt(0) ?? 0)) {
      return err(
        frmError(
          "validation",
          `secret ${name} came back from the Keychain in its hex form and does not decode to text; ` +
            `store it as a single line of printable text (JSON: compact, on one line)`,
        ),
      );
    }
  }
  return ok(text);
}
