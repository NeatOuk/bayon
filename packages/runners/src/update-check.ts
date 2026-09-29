// The runner update check's one shared primitive: a package name in, npm's published
// `latest` version out. No runner string here (Invariant 1) — the package name is the caller's own.
// One unauthenticated GET, no redirect followed, a 64 KiB cap enforced both by the header and while
// streaming, and the body kept to nothing but a version string that passes core's release pattern.
import { err, ok, RELEASE_VERSION, type Result } from "@bayon/core";
import { z } from "zod";
import type { Fetch } from "./adapter.js";
import { asFrmError, frmError } from "./errors.js";

const MAX_BYTES = 64 * 1024;

const NpmLatest = z.object({ version: RELEASE_VERSION });

/** Reads the response body up to `MAX_BYTES`; refuses (does not just truncate) anything larger. */
async function boundedText(res: Response): Promise<Result<string>> {
  const len = res.headers.get("content-length");
  if (len !== null && Number(len) > MAX_BYTES) {
    return err(
      frmError("validation", `the response is over ${MAX_BYTES} bytes`),
    );
  }
  if (res.body === null) {
    return ok(await res.text());
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return err(
        frmError("validation", `the response is over ${MAX_BYTES} bytes`),
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(new TextDecoder().decode(bytes));
}

/**
 * npm's published `latest` version of `pkg`: `GET https://registry.npmjs.org/<pkg>/latest`, no
 * credentials, no redirect followed. Only `version` is read from the body, and only once it passes
 * `RELEASE_VERSION` — nothing else of npm's answer is kept or trusted.
 */
export async function npmLatest(
  pkg: string,
  io: { readonly fetch: Fetch; readonly signal: AbortSignal },
): Promise<Result<string>> {
  let res: Response;
  try {
    res = await io.fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`,
      { method: "GET", redirect: "error", signal: io.signal },
    );
  } catch (e) {
    return err(
      asFrmError(e, "runner_error", `fetching npm's latest ${pkg} failed`),
    );
  }
  if (!res.ok) {
    return err(
      frmError("runner_error", `npm answered HTTP ${res.status} for ${pkg}`),
    );
  }
  const text = await boundedText(res);
  if (!text.ok) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.value);
  } catch {
    return err(frmError("validation", `npm's answer for ${pkg} is not JSON`));
  }
  const body = NpmLatest.safeParse(parsed);
  return body.success
    ? ok(body.data.version)
    : err(
        frmError("validation", `npm's answer for ${pkg} has no valid version`),
      );
}
