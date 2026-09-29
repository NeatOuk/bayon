// §15 #1 version + health: a version string is captured, and health answers with one. On an
// executor that places sessions (a container), health runs in a session of its own.
// The health check's detail is that version, which the certification pins (core
// pinnedHealthVersion).
import {
  HEALTH_VERSION_CHECK,
  VERSION_TEST_ID,
  type Result,
} from "@bayon/core";
import type { HealthPlace } from "../../adapter.js";
import type { SuiteCtx } from "../harness.js";
import { check, define } from "./define.js";

export interface VersionEvidence {
  readonly version: string;
  readonly health: Result<{ version: string }>;
}

export function judgeVersion(e: VersionEvidence) {
  return [
    check("version_captured", e.version.trim() !== "", e.version),
    check(
      HEALTH_VERSION_CHECK,
      e.health.ok && e.health.value.version.trim() !== "",
      e.health.ok ? e.health.value.version : e.health.error.message,
    ),
  ];
}

/** Where health may run: a placed session's root and tmp, or nowhere in particular (local). */
async function placeOf(ctx: SuiteCtx): Promise<HealthPlace | undefined> {
  if (ctx.subject.executor.placeSession === undefined) return undefined;
  const live = await ctx.open({ scenario: "plain" });
  return { cwd: live.dirs.root, tmp: live.dirs.tmpDir };
}

export const t01 = define({
  id: VERSION_TEST_ID,
  retries: 0,
  drive: async (ctx): Promise<VersionEvidence> => {
    const { adapter, executor } = ctx.subject;
    const version = await ctx.call("version", adapter.version());
    const at = await placeOf(ctx);
    return {
      version,
      health: await ctx.call(
        "health",
        at === undefined
          ? adapter.health(executor)
          : adapter.health(executor, at),
      ),
    };
  },
  judge: judgeVersion,
});
