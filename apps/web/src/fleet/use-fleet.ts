import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fleetQuery } from "@/api/queries";
import { useFeed } from "@/feed/feed";

/**
 * The fleet: one REST read, then every `fleet` snapshot (§12.2) replaces it. Budget, slots and
 * attention arrive computed by the server; the browser only renders them.
 */
export function useFleet() {
  const feed = useFeed();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      feed.subscribeFleet((next) => {
        queryClient.setQueryData(fleetQuery.queryKey, next);
      }),
    [feed, queryClient],
  );
  return useQuery(fleetQuery);
}
