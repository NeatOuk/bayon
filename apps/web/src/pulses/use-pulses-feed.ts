import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useFeed } from "@/feed/feed";
import {
  AGENT_PULSES_KEY,
  PULSE_KEY,
  pulseAgentsQuery,
  pulsesQuery,
} from "@/pulses/pulse-api";
import { mergePulses } from "@/pulses/pulse-model";

/**
 * The `pulses` topic (M2): each snapshot holds the newest pulses of every agent, whose rows change
 * state in place. It merges into the list, and refetches an open pulse, the next-pulse times and
 * each agent's own list (a frame holds the newest of every agent, so it may not hold that agent's).
 */
export function usePulsesFeed(): void {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      feed.subscribePulses((page) => {
        queryClient.setQueryData(pulsesQuery.queryKey, (known) =>
          known === undefined
            ? undefined
            : { items: mergePulses(known.items, page.items) },
        );
        void queryClient.invalidateQueries({ queryKey: PULSE_KEY });
        void queryClient.invalidateQueries({ queryKey: AGENT_PULSES_KEY });
        void queryClient.invalidateQueries({
          queryKey: pulseAgentsQuery.queryKey,
        });
      }),
    [feed, queryClient],
  );
}
