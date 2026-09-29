import type { CommandView } from "@bayon/proto";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { CommandStatus } from "@/commands/command-status";
import { Button } from "@/components/ui/button";
import {
  EXECUTORS_KEY,
  checkHealth,
  healthResult,
} from "@/executors/executors-api";

function healthText(command: CommandView | undefined, id: string): string {
  if (command === undefined) return `Health check queued (command ${id}).`;
  switch (command.state) {
    case "pending":
      return `Health check queued (command ${id}).`;
    case "claimed":
      return `Health check running on the supervisor (command ${id})…`;
    case "failed":
      return `Health check failed: ${command.error?.message ?? "the supervisor gave no reason"}.`;
    case "done": {
      const result = healthResult(command);
      return result === null
        ? `Health check done (command ${id}).`
        : `Health check done: ${result.executor_id} is ${result.health}.`;
    }
  }
}

/**
 * "Check health" (§6.1): queues one executor.health command, which the supervisor runs and
 * records; the executor's row (health, detail, checked at) is refetched once it settles.
 */
export function CheckHealth({ executorId }: { readonly executorId: string }) {
  const [commandId, setCommandId] = useState<string | null>(null);
  const check = useMutation({
    mutationFn: () => checkHealth(executorId),
    onSuccess: (accepted) => setCommandId(accepted.command_id),
  });
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        className="w-fit"
        disabled={check.isPending}
        onClick={() => {
          setCommandId(null);
          check.mutate();
        }}
      >
        Check health
      </Button>
      {check.isError && (
        <p role="alert" className="text-sm text-destructive">
          {check.error.message}
        </p>
      )}
      {commandId !== null && (
        <CommandStatus
          commandId={commandId}
          refresh={EXECUTORS_KEY}
          describe={(command) => healthText(command, commandId)}
        />
      )}
    </div>
  );
}
