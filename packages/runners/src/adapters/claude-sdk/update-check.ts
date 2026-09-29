// The claude-sdk adapter's `updateCheck`: the installed SDK's own version against npm's
// published latest, over the SDK's own package name only (Invariant 1: no adapter string leaves
// this file). The SDK's CHANGELOG is the one fixed URL a release's notes live at.
import { ok, type Result } from "@bayon/core";
import type { Fetch, RunnerUpdate } from "../../adapter.js";
import { npmLatest } from "../../update-check.js";
import { SDK_PACKAGE, sdkVersion } from "./registration.js";

export const SDK_CHANGELOG_URL =
  "https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md";

export async function updateCheck(io: {
  readonly fetch: Fetch;
  readonly signal: AbortSignal;
}): Promise<Result<RunnerUpdate>> {
  const latest = await npmLatest(SDK_PACKAGE, io);
  if (!latest.ok) return latest;
  return ok({
    current: sdkVersion(),
    latest: latest.value,
    notes_url: SDK_CHANGELOG_URL,
  });
}
