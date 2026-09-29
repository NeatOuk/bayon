// The opencode adapter's `updateCheck`: the pinned version against npm's `opencode-ai`,
// whose published version is the one `opencode --version` prints (registration.ts). No release page
// is confirmed for this pin, so `notes_url` is left out rather than guessed.
import { ok, type Result } from "@bayon/core";
import type { Fetch, RunnerUpdate } from "../../adapter.js";
import { npmLatest } from "../../update-check.js";
import { PINNED_VERSION } from "./registration.js";

const OPENCODE_PACKAGE = "opencode-ai";

export async function updateCheck(io: {
  readonly fetch: Fetch;
  readonly signal: AbortSignal;
}): Promise<Result<RunnerUpdate>> {
  const latest = await npmLatest(OPENCODE_PACKAGE, io);
  if (!latest.ok) return latest;
  return ok({ current: PINNED_VERSION, latest: latest.value });
}
