import {
  ExecutorCreated,
  ExecutorHealthAccepted,
  ExecutorHealthResult,
  ExecutorsView,
  type CommandView,
  type CreateExecutorRequest,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, postJson } from "@/api/http";

// The Executors page's REST (§6.1, §12.1): GET /executors (the rows, their last health
// check, and the untrusted-roles setting) and POST /executors/:id/health, whose executor.health
// command is followed with commands/ until the supervisor settles it. POST /executors (§9.5
// amendment) registers a new container executor.

/** GET /executors; a settled health check refreshes it by this key. */
export const EXECUTORS_KEY = ["executors"] as const;

export const executorsQuery = queryOptions({
  queryKey: EXECUTORS_KEY,
  queryFn: ({ signal }) => getJson("/executors", ExecutorsView, signal),
});

/** 202 with the executor.health command; 404 for an unknown executor. No body. */
export const checkHealth = (
  executorId: string,
): Promise<ExecutorHealthAccepted> =>
  postJson(
    `/executors/${encodeURIComponent(executorId)}/health`,
    {},
    ExecutorHealthAccepted,
  );

/** A done executor.health command's result; null while it runs, or if it does not parse. */
export function healthResult(
  command: CommandView,
): ExecutorHealthResult | null {
  const parsed = ExecutorHealthResult.safeParse(command.result);
  return parsed.success ? parsed.data : null;
}

/** 201 with the new executor's id; a 400 names the refused field, including an unpinned host. */
export const createExecutor = (
  body: CreateExecutorRequest,
): Promise<ExecutorCreated> => postJson("/executors", body, ExecutorCreated);
