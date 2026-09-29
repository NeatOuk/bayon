import {
  ApiErrorBody,
  IDEMPOTENCY_HEADER,
  IF_MATCH_HEADER,
  etagOf,
} from "@bayon/proto";
import { z } from "zod";
import { notifyUnauthorized } from "./unauthorized";

/** The REST prefix. The dev server proxies it to the API and adds the bearer (vite.config.ts). */
export const API_BASE = "/api/v1";

type WireError = ApiErrorBody["error"];

/**
 * A failed API call. `error` is the server's own when it sent one. The message is the server's
 * sentence alone, as the operator reads it; the class stays on `error.class` for code and logs.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly error: WireError;

  constructor(status: number, error: WireError) {
    super(error.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.error = error;
  }
}

const readJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

/**
 * Every call skips the browser's HTTP cache: API data is live state, and a cache can
 * hand back a stale body. The ticket GET's ETag is its version, not a hash of the body, so a
 * revalidation on it was answered 304 with a body cached before `next_step` existed. `cache` is set
 * last, and a caller cannot pass its own.
 */
async function request(
  path: string,
  init: Omit<RequestInit, "cache"> = {},
): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
  });
  if (response.ok) return response;
  // Behind the production edge a 401 means the login ended: the auth gate shows the login screen.
  if (response.status === 401) notifyUnauthorized();
  const body = ApiErrorBody.safeParse(await readJson(response));
  throw new ApiRequestError(
    response.status,
    body.success
      ? body.data.error
      : {
          class: "internal",
          message: `The server answered HTTP ${response.status} for ${path}: check that the API is running, then try again.`,
          retryable: response.status >= 500,
        },
  );
}

/** The body of a successful response, parsed with `schema` (a boundary: never trusted as-is). */
async function parsedBody<T>(
  path: string,
  response: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const parsed = schema.safeParse(await readJson(response));
  if (parsed.success) return parsed.data;
  // The schema's own complaint is for a developer: the console has it, the headline does not.
  console.warn(
    `unexpected response from ${path}`,
    z.prettifyError(parsed.error),
  );
  throw new ApiRequestError(response.status, {
    class: "validation",
    message: `The server's answer for ${path} could not be read: reload the page to get the GUI that matches it.`,
    retryable: false,
  });
}

/** GET a JSON body, parsed with `schema`. */
export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return parsedBody(path, await request(path, { signal }), schema);
}

/** GET a text body. */
export async function getText(
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await request(path, { signal })).text();
}

/**
 * Saves the attachment at `path` through the browser's own download, streamed to disk: never held
 * in the page. A same-origin `<a download>` authenticates as every fetch here does: the page never
 * holds the bearer, the dev proxy or the production edge adds it (the edge on the session cookie).
 * The page cannot see the download's progress or failure; the browser's download list does.
 */
export function downloadFile(path: string): void {
  const link = document.createElement("a");
  link.href = `${API_BASE}${path}`;
  // Empty: the server's Content-Disposition names the file.
  link.download = "";
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

/**
 * What a write may add: an abort signal, the version it read (sent as If-Match, M1 contract 3), and
 * the key identifying this one logical operation (sent as Idempotency-Key). The same key sent twice
 * returns the first command rather than making a second — so it must stay stable across a retry of
 * the same action, which is what `useIdempotencyKey` is for.
 */
export interface SendOptions {
  readonly signal?: AbortSignal;
  readonly version?: number;
  readonly idempotencyKey?: string;
}

async function sendJson<T>(
  method: "PUT" | "POST" | "PATCH",
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  { signal, version, idempotencyKey }: SendOptions = {},
): Promise<T> {
  const response = await request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(version === undefined ? {} : { [IF_MATCH_HEADER]: etagOf(version) }),
      ...(idempotencyKey === undefined
        ? {}
        : { [IDEMPOTENCY_HEADER]: idempotencyKey }),
    },
    body: JSON.stringify(body),
    signal,
  });
  return parsedBody(path, response, schema);
}

/** PUT a JSON body, parsing the response with `schema`. A non-2xx carries the server's own error. */
export const putJson = <T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  options?: SendOptions,
): Promise<T> => sendJson("PUT", path, body, schema, options);

/** POST a JSON body, parsing the response with `schema`. A non-2xx carries the server's own error. */
export const postJson = <T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  options?: SendOptions,
): Promise<T> => sendJson("POST", path, body, schema, options);

/** PATCH a JSON body, parsing the response with `schema`. A non-2xx carries the server's own error. */
export const patchJson = <T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
  options?: SendOptions,
): Promise<T> => sendJson("PATCH", path, body, schema, options);

/** DELETE with no body, parsing the response with `schema`. A non-2xx carries the server's own error. */
export async function deleteJson<T>(
  path: string,
  schema: z.ZodType<T>,
  { signal, idempotencyKey }: SendOptions = {},
): Promise<T> {
  return parsedBody(
    path,
    await request(path, {
      method: "DELETE",
      signal,
      ...(idempotencyKey === undefined
        ? {}
        : { headers: { [IDEMPOTENCY_HEADER]: idempotencyKey } }),
    }),
    schema,
  );
}
