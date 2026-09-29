import { err, ok, type FrmError, type Result } from "@bayon/core";
import { scrubSecrets, urlSecretParts } from "../../secret-scrub.js";
import { causeText, channelError, type Fetch } from "./channel.js";

// The HTTP channels' one door (§14 amendment): a POST to a URL read from the host store,
// https only (an `http:` URL is refused before any request), never following a redirect (a 3xx
// could carry the body, and any credential in the URL, wherever it pointed), inside a timeout, and
// reading at most 64 KiB of the answer. Userinfo in the URL becomes a Basic header, since fetch
// refuses a URL that holds credentials. Every message names the channel and never the URL, and is
// scrubbed of the URL's every secret part.

export const NOTIFY_HTTP_TIMEOUT_MS = 15_000;
export const NOTIFY_MAX_ANSWER_BYTES = 64 * 1024;
/** How much of a refusing answer's body an error quotes. */
const SNIPPET_MAX = 200;

export interface HttpsPost {
  /** For messages: `ntfy`, `webhook`. */
  readonly channel: string;
  /** The secret's name, for messages. */
  readonly secretName: string;
  /** The destination, from the host store. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly fetch: Fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface Target {
  readonly url: string;
  readonly authorization: string | null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The URL fetch is given, without its userinfo, and the Basic header that carries it instead. */
function targetOf(p: HttpsPost, fail: Fail): Result<Target> {
  if (!URL.canParse(p.url)) {
    return err(fail(`${p.secretName} is not a URL`, false));
  }
  const url = new URL(p.url);
  if (url.protocol !== "https:") {
    return err(
      fail(
        `${p.secretName} must be an https URL; ${url.protocol.replace(/:$/, "")} is refused`,
        false,
      ),
    );
  }
  const user = decode(url.username);
  const pass = decode(url.password);
  const authorization =
    user === "" && pass === ""
      ? null
      : `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  url.username = "";
  url.password = "";
  return ok({ url: url.href, authorization });
}

type Fail = (
  message: string,
  retryable: boolean,
  cls?: FrmError["class"],
) => FrmError;

/** At most `max` bytes of the answer as text; the rest is cancelled, never buffered. */
async function readSome(res: Response, max: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - size;
    chunks.push(value.subarray(0, Math.max(0, room)));
    size += value.byteLength;
    if (size >= max) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function thrown(
  p: HttpsPost,
  e: unknown,
  fail: Fail,
  timeoutMs: number,
): FrmError {
  if (p.signal?.aborted === true) {
    return fail(`the ${p.channel} send was stopped`, true, "interrupted");
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return fail(
      `${p.channel} did not answer within ${timeoutMs} ms`,
      true,
      "timeout",
    );
  }
  const text = causeText(e);
  if (/redirect/i.test(text)) {
    return fail(
      `${p.channel} answered with a redirect, which is refused: a notification goes to ${p.secretName} only`,
      false,
    );
  }
  const code = /\b(E[A-Z_]{3,})\b/.exec(text)?.[1] ?? "a network error";
  return fail(`${p.channel} could not be reached (${code})`, true);
}

/** POSTs `body` to the destination: ok on a 2xx, else the typed error the deliverer acts on. */
export async function postHttps(p: HttpsPost): Promise<Result<void>> {
  const secrets = urlSecretParts(p.url);
  const fail: Fail = (message, retryable, cls = "runner_error") =>
    channelError(cls, message, retryable, secrets);
  const target = targetOf(p, (m, r) => fail(m, r, "validation"));
  if (!target.ok) return target;
  const timeoutMs = p.timeoutMs ?? NOTIFY_HTTP_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    p.signal === undefined ? timeout : AbortSignal.any([timeout, p.signal]);
  try {
    const res = await p.fetch(target.value.url, {
      method: "POST",
      headers: {
        ...p.headers,
        ...(target.value.authorization === null
          ? {}
          : { Authorization: target.value.authorization }),
      },
      body: p.body,
      // Never follow: a 3xx would carry the notification, and its Basic header, wherever it pointed.
      redirect: "error",
      signal,
    });
    const answer = await readSome(res, NOTIFY_MAX_ANSWER_BYTES);
    if (res.status >= 200 && res.status < 300) return ok(undefined);
    // Scrubbed whole, then cut: a cut first could keep a fragment of a secret the scrub then misses.
    const said = scrubSecrets(answer.trim(), secrets).slice(0, SNIPPET_MAX);
    const detail = said === "" ? "" : `: ${said}`;
    const retryable = res.status === 429 || res.status >= 500;
    return err(
      fail(`${p.channel} answered HTTP ${res.status}${detail}`, retryable),
    );
  } catch (e) {
    return err(thrown(p, e, fail, timeoutMs));
  }
}
