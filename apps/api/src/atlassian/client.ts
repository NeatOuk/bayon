import {
  err,
  isJiraSite,
  jiraHost,
  ok,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";
import { scrubSecrets } from "../secret-scrub.js";

// The guards every Atlassian Cloud call of ours goes through (extracted for; written for
// the Jira mirror). They are not Jira's and they are not Confluence's —
// they are what makes it safe to send the operator's token to a site a REST caller named:
//
//   * **the site pin** — every request's origin is checked against `https://<name>.atlassian.net`
//     here, before it is sent, whatever wrote the row it came from;
//   * **`redirect: "error"`** — a 3xx is refused rather than followed, so no redirect can carry the
//     `Authorization` header to another host;
//   * **the body cap** — an answer is refused by its Content-Length before a byte is read, and cut
//     off as the stream passes the cap when there is none;
//   * **the scrub** — no message this builds names the token or the header built from it, in any
//     form (raw, base64, base64url, %-encoded);
//   * **the login check** — Atlassian serves a rejected email and token pair as *anonymous*, and an
//     anonymous read is a 200 with nothing in it, so a call asks who the auth logs in as first, and
//     any answer marked `X-Seraph-LoginReason: AUTHENTICATED_FAILED` fails the same way.
//
// One product's messages differ from another's by four words, not by code: an `AtlassianApi` record
// carries the product's name, what a refused request is called, what an interrupt stops, and what
// the token must be allowed to do. Every string the Jira client produced before this extraction it
// still produces, byte for byte.

/** `fetch`, injected: tests point it at a local fixture server. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AtlassianAuth {
  /** The Atlassian account the token belongs to. */
  readonly email: string;
  /** From the host secret store, at call time; never stored. */
  readonly token: string;
}

/** What one product calls things, so one message builder serves both. */
export interface AtlassianApi {
  /** The product in every message: `Jira`, `Confluence`. */
  readonly product: string;
  /** What a refused request is called: "the search", "the request". */
  readonly what: string;
  /** What an interrupt stops: "the Jira sync", "the documentation read". */
  readonly work: string;
  /** What the token must be allowed to do: "browse the query's projects". */
  readonly mayBrowse: string;
  /** Who the auth logs in as, on this product. */
  readonly loginPath: string;
}

export interface AtlassianOptions {
  readonly fetch: Fetch;
  /** Each request's limit. */
  readonly timeoutMs: number;
  /** Aborts every request of the call: the API stopping. */
  readonly signal?: AbortSignal;
  /** The largest body read; tests lower it. */
  readonly maxBodyBytes?: number;
}

/** The largest answer read: anything past it is refused. */
export const ATLASSIAN_MAX_BODY_BYTES = 16 * 1024 * 1024;
/** The longest message kept from the product's own error body. */
export const ATLASSIAN_MESSAGE_MAX = 500;
/** The header Atlassian marks a request it served anonymously with, whatever its status. */
const LOGIN_REASON = "x-seraph-loginreason";
const LOGIN_FAILED = "AUTHENTICATED_FAILED";

/** One call in flight: its product, its site, its auth and its transport. */
export interface Call extends AtlassianOptions {
  readonly api: AtlassianApi;
  readonly site: string;
  readonly auth: AtlassianAuth;
}

const basic = (auth: AtlassianAuth): string =>
  `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`;

/**
 * `message` without the token or the header built from it, whatever put them there: the shared
 * scrub (secret-scrub.ts) over the token and the Basic pair, raw and encoded.
 */
export function scrubSecret(message: string, auth: AtlassianAuth): string {
  return scrubSecrets(message, [auth.token, `${auth.email}:${auth.token}`]);
}

export const cap = (text: string): string =>
  text.length <= ATLASSIAN_MESSAGE_MAX
    ? text
    : `${text.slice(0, ATLASSIAN_MESSAGE_MAX - 1)}…`;

export function failure(
  call: Call,
  errorClass: ErrorClass,
  message: string,
  retryable: boolean,
  /** The product's HTTP status, kept server-side (a cause never leaves it). */
  status?: number,
): FrmError {
  return {
    class: errorClass,
    message: scrubSecret(cap(message), call.auth),
    retryable,
    ...(status === undefined ? {} : { cause: { http_status: status } }),
  };
}

/** The product's error body, read loosely: whatever does not parse says nothing. */
const AtlassianErrorBody = (body: unknown): readonly string[] => {
  if (typeof body !== "object" || body === null) return [];
  const said = body as { errorMessages?: unknown; errors?: unknown };
  const list = Array.isArray(said.errorMessages)
    ? said.errorMessages.filter((m): m is string => typeof m === "string")
    : [];
  const map =
    typeof said.errors === "object" && said.errors !== null
      ? Object.values(said.errors).filter(
          (m): m is string => typeof m === "string",
        )
      : [];
  return [...list, ...map];
};

/** The messages a thrown fetch error carries, its causes' included. */
function causeText(e: unknown, depth = 0): string {
  if (!(e instanceof Error) || depth > 3) return "";
  const code = "code" in e && typeof e.code === "string" ? ` ${e.code}` : "";
  return `${e.message}${code} ${causeText(e.cause, depth + 1)}`;
}

export function thrown(call: Call, e: unknown): FrmError {
  const host = jiraHost(call.site);
  const { product, work } = call.api;
  if (call.signal?.aborted === true) {
    return failure(call, "interrupted", `${work} of ${host} was stopped`, true);
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return failure(
      call,
      "timeout",
      `${product} at ${host} did not answer within ${call.timeoutMs} ms`,
      true,
    );
  }
  const text = causeText(e);
  if (/redirect/i.test(text)) {
    return failure(
      call,
      "runner_error",
      `${product} at ${host} answered with a redirect, which is refused: the token goes to ${host} only`,
      false,
    );
  }
  const code = /\b(E[A-Z_]{3,})\b/.exec(text)?.[1] ?? "a network error";
  return failure(
    call,
    "runner_error",
    `${product} at ${host} could not be reached (${code})`,
    true,
  );
}

/**
 * The product served the request as anonymous, or refused who the auth logs in as: a wrong email
 * and token pair. An anonymous read answers 200 with nothing, so this is what tells the two apart.
 */
export function loginRejected(call: Call, status?: number): FrmError {
  return failure(
    call,
    "validation",
    `${call.api.product} didn't accept the API token for ${call.auth.email} on ${jiraHost(call.site)}. The token must come from that same Atlassian account (id.atlassian.com → Security → API tokens). A token stored through the \`security\` prompt is cut to 128 characters; store it with \`-w "$(pbpaste)"\` instead.`,
    false,
    status,
  );
}

const servedAnonymously = (res: Response): boolean =>
  (res.headers.get(LOGIN_REASON) ?? "").toUpperCase().includes(LOGIN_FAILED);

/** How a non-200 answer becomes the error the caller reports. */
export type Refuse = (call: Call, status: number, body: string) => FrmError;

/** A non-200 answer as the error the caller reports. */
export function refused(call: Call, status: number, body: string): FrmError {
  const host = jiraHost(call.site);
  const { product, what, mayBrowse } = call.api;
  const fail = (errorClass: ErrorClass, message: string, retryable: boolean) =>
    failure(call, errorClass, message, retryable, status);
  if (status === 401 || status === 403) {
    return fail(
      "validation",
      `${product} refused the token for ${host}: check JIRA_API_TOKEN (HTTP ${status}; it must be an API token of ${call.auth.email} that may ${mayBrowse})`,
      false,
    );
  }
  if (status === 429 || status >= 500) {
    return fail(
      "runner_error",
      `${product} at ${host} answered HTTP ${status}; the next sync tries again`,
      true,
    );
  }
  if (status === 400) {
    const said = parseJson(body);
    const messages = AtlassianErrorBody(said.ok ? said.value : {});
    return fail(
      "validation",
      `${product} refused the query for ${host}: ${messages.length === 0 ? "HTTP 400" : messages.join("; ")}`,
      false,
    );
  }
  return status >= 400
    ? fail(
        "validation",
        `${product} at ${host} refused ${what} (HTTP ${status})`,
        false,
      )
    : fail(
        "runner_error",
        `${product} at ${host} answered HTTP ${status}`,
        false,
      );
}

export function parseJson(text: string): Result<unknown> {
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

/**
 * `res`'s body as text, or null when it is larger than `max` bytes: refused by its Content-Length
 * before a byte is read, else cut off as the stream passes `max`. Never buffers more than `max`.
 */
export async function readCapped(
  res: Response,
  max: number,
): Promise<string | null> {
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

/** What one request sends: its method, and for a write its JSON body. */
interface Sent {
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  /** The statuses that are success: GET 200; a write 200, 201 or 204. */
  readonly accepted: readonly number[];
}

/**
 * One request to `url` through every guard, answered with JSON (or null for an empty success, a
 * 204), or the error it came to. Any answer the product marks as served anonymously is the login
 * error, its body unread, whatever its status.
 */
async function requestJson(
  call: Call,
  url: string,
  sent: Sent,
  refuse: Refuse,
): Promise<Result<unknown>> {
  const timeout = AbortSignal.timeout(call.timeoutMs);
  const signal =
    call.signal === undefined
      ? timeout
      : AbortSignal.any([timeout, call.signal]);
  try {
    const res = await call.fetch(url, {
      method: sent.method,
      headers: {
        Accept: "application/json",
        Authorization: basic(call.auth),
        ...(sent.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(sent.body === undefined ? {} : { body: JSON.stringify(sent.body) }),
      // Never follow: a 3xx would carry the Authorization header wherever it pointed.
      redirect: "error",
      signal,
    });
    if (servedAnonymously(res)) {
      await res.body?.cancel();
      // No status in its cause: a 400 served anonymously must not read as a refused query.
      return err(loginRejected(call));
    }
    const max = call.maxBodyBytes ?? ATLASSIAN_MAX_BODY_BYTES;
    const body = await readCapped(res, max);
    if (body === null) {
      return err(
        failure(
          call,
          "runner_error",
          `${call.api.product} at ${jiraHost(call.site)} answered with a body over ${max} bytes, which is refused`,
          false,
        ),
      );
    }
    if (!sent.accepted.includes(res.status))
      return err(refuse(call, res.status, body));
    // A write's success may carry no body (Jira answers a transition 204).
    if (sent.method !== "GET" && body.trim() === "") return ok(null);
    const json = parseJson(body);
    return json.ok
      ? json
      : err(
          failure(
            call,
            "runner_error",
            `${call.api.product} at ${jiraHost(call.site)} answered with a body that is not JSON`,
            false,
          ),
        );
  } catch (e) {
    return err(thrown(call, e));
  }
}

/**
 * One GET of `url`, answered 200 with JSON, or the error it came to. Any answer the product marks
 * as served anonymously is the login error, its body unread, whatever its status.
 */
export function getJson(
  call: Call,
  url: string,
  refuse: Refuse = refused,
): Promise<Result<unknown>> {
  return requestJson(call, url, { method: "GET", accepted: [200] }, refuse);
}

/**
 * One POST of `body` as JSON to `url` (Jira following the ticket), through the same
 * guards as a read: the site checked again first, no redirect followed, the answer capped, every
 * message scrubbed. Success is 200, 201 or 204; its JSON, or null when it has none.
 */
export function postJson(
  call: Call,
  url: string,
  body: unknown,
  refuse: Refuse = refused,
): Promise<Result<unknown>> {
  const site = checkSite(call.site, call.api, call.auth);
  if (!site.ok) return Promise.resolve(site);
  if (!url.startsWith(`${call.site}/`))
    return Promise.resolve(
      err(
        failure(
          call,
          "validation",
          `a ${call.api.product} write must go to ${jiraHost(call.site)}`,
          false,
        ),
      ),
    );
  return requestJson(
    call,
    url,
    { method: "POST", body, accepted: [200, 201, 204] },
    refuse,
  );
}

/**
 * `site` held to `https://<name>.atlassian.net`, checked again here before every call, whatever
 * wrote it: the one reason the operator's token can only ever reach Atlassian's own servers.
 */
export function checkSite(
  site: string,
  api: AtlassianApi,
  auth: AtlassianAuth,
): Result<string> {
  return isJiraSite(site)
    ? ok(site)
    : err({
        class: "validation",
        message: scrubSecret(
          `${cap(site)} is not a ${api.product} Cloud site (https://<name>.atlassian.net)`,
          auth,
        ),
        retryable: false,
      });
}

/** Who the auth logs in as, read loosely: an account id says it logged in; nothing of it is kept. */
const accountIdOf = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { accountId?: unknown }).accountId;
  return typeof id === "string" && id !== "" ? id : undefined;
};

/** The login path's 401 and 403 are the login refused; any other status is mapped as a read's. */
export const refusedLogin: Refuse = (call, status, body) =>
  status === 401 || status === 403
    ? loginRejected(call, status)
    : refused(call, status, body);

/**
 * Who the auth logs in as, before any read: a pair the product rejects fails here, not as an empty
 * result. Returns the account id; nothing else of the answer is kept.
 */
export async function checkLogin(call: Call): Promise<Result<string>> {
  const json = await getJson(
    call,
    `${call.site}${call.api.loginPath}`,
    refusedLogin,
  );
  if (!json.ok) return json;
  const id = accountIdOf(json.value);
  return id === undefined
    ? err(
        failure(
          call,
          "runner_error",
          `${call.api.product} at ${jiraHost(call.site)} answered ${call.api.loginPath} with a body this cannot read`,
          false,
        ),
      )
    : ok(id);
}
