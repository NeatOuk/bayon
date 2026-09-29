import type { CommandView } from "@bayon/proto";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { commandQuery, isSettled } from "@/commands/commands-api";

/**
 * A queued command's state as the supervisor moves it, in a polite live region; once it settles,
 * the queries under `refresh` are refetched (the rows the command changed).
 */
export function CommandStatus({
  commandId,
  refresh,
  describe,
}: {
  readonly commandId: string;
  readonly refresh: QueryKey;
  readonly describe: (command: CommandView | undefined) => string;
}) {
  const queryClient = useQueryClient();
  const command = useQuery(commandQuery(commandId));
  const settled = isSettled(command.data);
  useEffect(() => {
    if (settled) void queryClient.invalidateQueries({ queryKey: refresh });
  }, [settled, queryClient, refresh]);
  return (
    <p role="status" aria-live="polite" className="text-sm">
      {command.isError
        ? `The command cannot be read: ${command.error.message}`
        : describe(command.data)}
    </p>
  );
}
