import { SessionDiff } from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "@/api/http";

/**
 * `GET /sessions/:id/diff` (§12.1): what the session changed, per repo, each patch capped
 * by the API (§8.5) with the full patch's path. Read when the Diff tab opens and on Refresh.
 */
export const sessionDiffQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["session-diff", sessionId],
    queryFn: ({ signal }) =>
      getJson(
        `/sessions/${encodeURIComponent(sessionId)}/diff`,
        SessionDiff,
        signal,
      ),
  });
