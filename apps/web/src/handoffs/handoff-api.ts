import {
  CommandAccepted,
  HandoffDetail,
  type SessionHandoffRequest,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, postJson } from "@/api/http";
import { retryUnlessFinal } from "@/api/query-client";

// hand-off routes (§12.1): GET /handoffs/:id and POST /sessions/:id/handoff.

/** `GET /handoffs/:id`: the packet, its facts and its judgement. */
export const handoffQuery = (id: string) =>
  queryOptions({
    queryKey: ["handoff", id],
    queryFn: ({ signal }) =>
      getJson(`/handoffs/${encodeURIComponent(id)}`, HandoffDetail, signal),
    // An unknown hand-off or a bad id is an answer; only what the server calls retryable retries.
    retry: retryUnlessFinal,
  });

/** `POST /sessions/:id/handoff` (§7.1): the operator hands the session off now. */
export const handOffSession = (
  sessionId: string,
  note: string | undefined,
): Promise<CommandAccepted> => {
  const body: SessionHandoffRequest = {
    reason: "operator",
    ...(note === undefined ? {} : { note }),
  };
  return postJson(
    `/sessions/${encodeURIComponent(sessionId)}/handoff`,
    body,
    CommandAccepted,
  );
};
