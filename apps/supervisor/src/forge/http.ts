import {
  err,
  ok,
  type Clock,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";
import { scrubToken } from "./scrub.js";

// The forge client's HTTP floor (spike §1.4), carrying the Jira client's guards one for
// one, because they are the ones that keep a token from leaving the host it belongs to:
//
//   * https only, checked immediately before every request, whatever wrote the URL;
//   * `redirect: "error"` — a 3xx would carry the Authorization header to another host;
//   * a timeout, and the daemon's own stop signal;
//   * a body cap, refused by Content-Length before a byte is read and again as the stream passes it;
//   * every message scrubbed of the token before it is returned, stored or logged;
//   * one bounded retry when the forge says it is rate-limiting us, waiting through the injected
//     clock so a test never sleeps.
//
// Nothing here knows GitHub, or any forge: `github.ts` builds URLs and reads bodies.

/** `fetch`, injected: tests point it at a local fixture server. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export const FORGE_TIMEOUT_MS = 30_000;
/** The largest answer read; a pull request is a few KB. */
export const FORGE_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** The longest message kept from a forge's own error body. */
export const FORGE_MESSAGE_MAX = 500;
/** How many times one rate-limited call is retried before it gives up. */
export const FORGE_MAX_RETRIES = 2;
/** The longest a retry will wait, whatever `Retry-After` says. */
export const FORGE_RETRY_MAX_MS = 60_000;
/** What a retry waits when the forge named no delay. */
export const FORGE_RETRY_DEFAULT_MS = 1_000;

export interface ForgeHttp {
  readonly fetch: Fetch;
  /** The token, from the host secret store; never stored, never logged (§14). */
  readonly token: string;
  /** Names the forge in a message: its host, never a URL. */
  readonly host: string;
  readonly clock: Clock;
  /** Each request's limit. */
  readonly timeoutMs?: number;
  /** Aborts every request of the call: the daemon stopping. */
  readonly signal?: AbortSignal;
  readonly maxBodyBytes?: number;
  readonly maxRetries?: number;
}

export interface ForgeRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  /** JSON-encoded as the body; absent for a GET. */
  readonly body?: unknown;
  /** What to call this call in a message. */
  readonly what: string;
}

/** A forge's answer: its status, and its body parsed as JSON (null when it sent none). */
export interface ForgeAnswer {
  readonly status: number;
  readonly json: unknown;
}

const cap = (text: string): string =>
  text.length <= FORGE_MESSAGE_MAX
    ? text
    : `${text.slice(0, FORGE_MESSAGE_MAX - 1)}…`;

/** Every message leaves through here: capped, then scrubbed of the token in every form. */
export function forgeError(
  h: ForgeHttp,
  errorClass: ErrorClass,
  message: string,
  retryable: boolean,
  status?: number,
): FrmError {
  return {
    class: errorClass,
    message: scrubToken(cap(message), h.token),
    retryable,
    ...(status === undefined ? {} : { cause: { http_status: status } }),
  };
}

/** The messages a thrown fetch error carries, its causes' included. */
function causeText(e: unknown, depth = 0): string {
  if (!(e instanceof Error) || depth > 3) return "";
  const code = "code" in e && typeof e.code === "string" ? ` ${e.code}` : "";
  return `${e.message}${code} ${causeText(e.cause, depth + 1)}`;
}

function thrown(h: ForgeHttp, r: ForgeRequest, e: unknown): FrmError {
  if (h.signal?.aborted === true) {
    return forgeError(h, "interrupted", `${r.what} was stopped`, true);
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return forgeError(
      h,
      "timeout",
      `${h.host} did not answer ${r.what} within ${h.timeoutMs ?? FORGE_TIMEOUT_MS} ms`,
      true,
    );
  }
  const text = causeText(e);
  if (/redirect/i.test(text)) {
    return forgeError(
      h,
      "runner_error",
      `${h.host} answered ${r.what} with a redirect, which is refused: the token goes to ${h.host} only`,
      false,
    );
  }
  const code = /\b(E[A-Z_]{3,})\b/.exec(text)?.[1] ?? "a network error";
  return forgeError(
    h,
    "runner_error",
    `${h.host} could not be reached for ${r.what} (${code})`,
    true,
  );
}

/**
 * `res`'s body as text, or null when it is larger than `max` bytes: refused by its Content-Length
 * before a byte is read, else cut off as the stream passes `max`. Never buffers more than `max`.
 */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The forge is rate-limiting us: 429, or a 403 whose remaining budget is zero. */
export const rateLimited = (
  res: Pick<Response, "status" | "headers">,
): boolean =>
  res.status === 429 ||
  (res.status === 403 &&
    (res.headers.get("x-ratelimit-remaining") ?? "") === "0");

/** How long to wait before a retry: `Retry-After` seconds, bounded; else a fixed short wait. */
export function retryDelayMs(headers: Headers, now: number): number {
  const after = headers.get("retry-after");
  if (after !== null) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, FORGE_RETRY_MAX_MS);
    }
  }
  const reset = Number(headers.get("x-ratelimit-reset") ?? "");
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1_000 - now, 0), FORGE_RETRY_MAX_MS);
  }
  return FORGE_RETRY_DEFAULT_MS;
}

function parseJson(text: string): Result<unknown> {
  if (text.trim() === "") return ok(null);
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return err({
      class: "runner_error",
      message: "not JSON",
      retryable: false,
    });
  }
}

/** One request, with no retry of its own. */
async function once(
  h: ForgeHttp,
  r: ForgeRequest,
): Promise<Result<ForgeAnswer | { readonly retryAfterMs: number }>> {
  // Checked here, before every request, whatever built the URL: a token goes to https or nowhere.
  if (!URL.canParse(r.url) || new URL(r.url).protocol !== "https:") {
    return err(
      forgeError(
        h,
        "validation",
        `${r.what}: ${r.url} is not an https URL`,
        false,
      ),
    );
  }
  const timeoutMs = h.timeoutMs ?? FORGE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    h.signal === undefined ? timeout : AbortSignal.any([timeout, h.signal]);
  try {
    const res = await h.fetch(r.url, {
      method: r.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${h.token}`,
        "User-Agent": "bayon",
        ...(r.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
      // Never follow: a 3xx would carry the Authorization header wherever it pointed.
      redirect: "error",
      signal,
    });
    if (rateLimited(res)) {
      const wait = retryDelayMs(res.headers, h.clock.now());
      await res.body?.cancel();
      return ok({ retryAfterMs: wait });
    }
    const max = h.maxBodyBytes ?? FORGE_MAX_BODY_BYTES;
    const body = await readCapped(res, max);
    if (body === null) {
      return err(
        forgeError(
          h,
          "runner_error",
          `${h.host} answered ${r.what} with a body over ${max} bytes, which is refused`,
          false,
        ),
      );
    }
    const json = parseJson(body);
    return json.ok
      ? ok({ status: res.status, json: json.value })
      : err(
          forgeError(
            h,
            "runner_error",
            `${h.host} answered ${r.what} with a body that is not JSON`,
            false,
          ),
        );
  } catch (e) {
    return err(thrown(h, r, e));
  }
}

const isRetry = (
  a: ForgeAnswer | { readonly retryAfterMs: number },
): a is { readonly retryAfterMs: number } => "retryAfterMs" in a;

/**
 * One call to a forge: the answer's status and JSON body, or the error it came to. A rate-limited
 * answer is retried up to `maxRetries` times, waiting what the forge asked for (bounded); past that
 * it is a retryable error and the next sweep tries again.
 */
export async function forgeCall(
  h: ForgeHttp,
  r: ForgeRequest,
): Promise<Result<ForgeAnswer>> {
  const tries = (h.maxRetries ?? FORGE_MAX_RETRIES) + 1;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const answer = await once(h, r);
    if (!answer.ok) return answer;
    if (!isRetry(answer.value)) return ok(answer.value);
    if (attempt + 1 === tries) break;
    try {
      await h.clock.after(answer.value.retryAfterMs, h.signal);
    } catch {
      return err(forgeError(h, "interrupted", `${r.what} was stopped`, true));
    }
  }
  return err(
    forgeError(
      h,
      "runner_error",
      `${h.host} is rate-limiting ${r.what}; the next pass tries again`,
      true,
      429,
    ),
  );
}
