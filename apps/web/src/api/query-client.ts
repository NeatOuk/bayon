import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/api/http";

/** Tries a read makes at most, as TanStack's default does. */
export const MAX_TRIES = 3;

/**
 * A refusal the server says is final (a 404, a bad filter's 400), or a body the schema rejects, is
 * shown at once; anything else (a 5xx the server calls retryable, a network failure) is tried again.
 * TanStack's default retries all of them, and a hidden tab pauses the retry: a final error then
 * reads as "loading…" for as long as the tab stays hidden.
 */
export const retryUnlessFinal = (failures: number, error: Error): boolean =>
  failures < MAX_TRIES &&
  !(error instanceof ApiRequestError && !error.error.retryable);

/** The app's QueryClient: every query retries with `retryUnlessFinal`. */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: retryUnlessFinal } },
  });
