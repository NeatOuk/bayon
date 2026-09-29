import { CommandView } from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "@/api/http";

// GET /commands/:id (§12.1): how the GUI follows a command it queued (runner.conformance,
// executor.health) until the supervisor settles it.

/** How often a queued command is read again until it is done or failed. */
export const COMMAND_POLL_MS = 2_000;

export const isSettled = (command: CommandView | undefined): boolean =>
  command?.state === "done" || command?.state === "failed";

/** GET /commands/:id, polled while the supervisor has not settled it. */
export const commandQuery = (id: string) =>
  queryOptions({
    queryKey: ["command", id],
    queryFn: ({ signal }) =>
      getJson(`/commands/${encodeURIComponent(id)}`, CommandView, signal),
    refetchInterval: (query) =>
      isSettled(query.state.data) ? false : COMMAND_POLL_MS,
  });
