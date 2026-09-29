// The retry storm's notification. The gate is admission's and stays so:
// this only reads the same failures through the same core function (retryStormHolds) and files one
// human_request per pair while none is open, and one per outage (keyed on the pair's last ok run).
import {
  dedupePrefix,
  pairKey,
  retryStormHolds,
  type RetryStormSettings,
} from "@bayon/core";
import {
  hasOpenSystemRequest,
  lastPairOkRunAt,
  listPairFailuresSince,
  listStormPairs,
} from "@bayon/db";
import { insertSystemHumanRequest } from "@bayon/db/supervisor";
import type { WatchdogDeps } from "./ports.js";
import { STORM_OPTIONS, stormContext, stormQuestion } from "./texts.js";

export async function stormRule(
  d: WatchdogDeps,
  storm: RetryStormSettings,
): Promise<void> {
  const now = d.clock.now();
  const since = now - storm.windowMs - storm.backoffMs;
  const pairs = await listStormPairs(d.db, { since, minCount: storm.count });
  if (!pairs.ok) {
    d.log.error({ error: pairs.error }, "storm: cannot list pairs");
    return;
  }
  for (const pair of pairs.value) {
    const failures = await listPairFailuresSince(d.db, {
      runnerId: pair.runnerId,
      executorId: pair.executorId,
      since,
    });
    if (!failures.ok) continue;
    const hold = retryStormHolds(failures.value, storm)
      .filter((h) => h.until > now)
      .at(-1);
    if (hold === undefined) continue;
    const subject = pairKey(pair.runnerId, pair.executorId);
    // One open request per pair (LOW-3): race-free, the watchdog is this rule's only writer.
    const open = await hasOpenSystemRequest(
      d.db,
      dedupePrefix("retry_storm", subject),
    );
    if (!open.ok || open.value) continue;
    const recovered = await lastPairOkRunAt(d.db, pair);
    if (!recovered.ok) continue;
    const filed = await insertSystemHumanRequest(d.db, {
      rule: "retry_storm",
      subject,
      window: String(recovered.value ?? 0),
      question: stormQuestion({
        runnerId: pair.runnerId,
        executorId: pair.executorId,
        count: storm.count,
        windowMs: storm.windowMs,
        until: hold.until,
      }),
      context_md: stormContext({
        ...hold,
        recoveredAt: recovered.value,
        failures: failures.value.length,
      }),
      options: [...STORM_OPTIONS],
      expires_at: hold.until,
    });
    if (!filed.ok) {
      d.log.error({ subject, error: filed.error }, "storm: cannot file");
    } else if (filed.value.created) {
      d.log.warn(
        { subject, until: hold.until, request: filed.value.row.id },
        "storm: filed a human request",
      );
    }
  }
}
