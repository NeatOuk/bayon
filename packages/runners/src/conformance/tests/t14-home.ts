// §15 #14 home claim (non-negotiable): a runner home is claimed by one session, a second claim on
// the same home is refused, and the first may reclaim it. One session at a time is all this needs,
// so it holds for every runner whatever its credential can serve; two sessions not contending is
// test 15. Model-free: no process is spawned.
import type { Result } from "@bayon/core";
import { check, define } from "./define.js";

export interface HomeClaimEvidence {
  readonly first: Result<unknown>;
  readonly second: Result<unknown>;
  readonly again: Result<unknown>;
}

export function judgeHomeClaim(e: HomeClaimEvidence) {
  return [
    check(
      "first_claim_ok",
      e.first.ok,
      e.first.ok ? null : e.first.error.message,
    ),
    check(
      "second_claim_refused",
      !e.second.ok && e.second.error.class === "conflict",
      e.second.ok
        ? "a second session claimed the same home"
        : e.second.error.class,
    ),
    check("reclaim_ok", e.again.ok, e.again.ok ? null : e.again.error.message),
  ];
}

export const t14 = define({
  id: 14,
  retries: 0,
  drive: async (ctx): Promise<HomeClaimEvidence> => {
    const a = await ctx.open({ scenario: "plain" });
    const b = await ctx.open({ scenario: "plain", homeDir: a.dirs.homeDir });
    const first = await a.prepareHome();
    const second = await b.prepareHome();
    const again = await a.prepareHome();
    // Only their claims were needed: closed, so the suite never holds more than it declares
    // (SUITE_PEAK_SESSIONS, an earlier change H2).
    await ctx.close(a);
    await ctx.close(b);
    return { first, second, again };
  },
  judge: judgeHomeClaim,
});
