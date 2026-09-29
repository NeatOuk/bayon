import type { SpendReport, SpendSummary } from "@bayon/proto";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useFeed } from "@/feed/feed";
import { SPEND_KEY, projectSpendKey } from "@/spend/spend-api";

/**
 * The fleet's money in a summary: what only a spend row written, wasted or aged out of a window can
 * move. The window's bounds and the projection move with the clock alone, so a frame goes out every
 * second (the hub sends a snapshot when its JSON changes); these do not. The fleet's pause rides
 * along: it decides whether a project's drop is reported, so it refetches too.
 */
export const moneyOf = (summary: SpendSummary): string =>
  JSON.stringify([
    summary.total_usd,
    summary.wasted_usd,
    summary.burn.today_usd,
    summary.burn.month_to_date_usd,
    summary.alarm.last_day.daily_usd,
    summary.alarm.last_day.baseline_daily_usd,
    summary.alarm.last_7d.daily_usd,
    summary.alarm.last_7d.baseline_daily_usd,
    summary.alarm.paused,
  ]);

/**
 * The `spend` topic (§8.9): each snapshot is the summary, so it replaces every report's.
 *
 * With `project` the frame is the fleet's summary, never the project's, so nothing is
 * read off it: the project's reports are refetched when the fleet's money moved (moneyOf), the first
 * frame included. A frame that moved only the clock refetches nothing.
 */
export function useSpendFeed(project?: string): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (project !== undefined) {
      let last: string | null = null;
      return feed.subscribeSpend((summary) => {
        const money = moneyOf(summary);
        if (money === last) return;
        last = money;
        void queryClient.invalidateQueries({
          queryKey: projectSpendKey(project),
        });
      });
    }
    return feed.subscribeSpend((summary) => {
      queryClient.setQueriesData<SpendReport>(
        { queryKey: SPEND_KEY },
        (report) => report && { ...report, summary },
      );
    });
  }, [feed, queryClient, project]);
}
