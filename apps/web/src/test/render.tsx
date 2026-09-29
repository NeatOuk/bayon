import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { Toaster } from "@/components/ui/toast";
import { FeedProvider, type Feed } from "@/feed/feed";

/** A feed that never delivers anything, but reports itself connected. */
export const silentFeed: Feed = {
  subscribeEvents: () => () => undefined,
  subscribeFleet: () => () => undefined,
  subscribeTickets: () => () => undefined,
  subscribeSpend: () => () => undefined,
  subscribePulses: () => () => undefined,
  subscribeInbox: () => () => undefined,
  subscribeGates: () => () => undefined,
  subscribeStatus: () => () => undefined,
  status: "open",
};

export function renderWithProviders(
  ui: ReactNode,
  { feed = silentFeed }: { readonly feed?: Feed } = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedProvider feed={feed}>{ui}</FeedProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** The subset of `fetch`'s signature a stub needs; `init` is unused, kept only for callers to inspect. */
type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * A route's answer to one call; `init` tells a GET from a POST. A `Response` is sent as-is; a promise
 * holds the call open until it settles (a request in flight).
 */
export type RouteHandler = (init: RequestInit | undefined) => unknown;

const toResponse = (body: unknown): Response =>
  body instanceof Response
    ? body
    : typeof body === "string"
      ? new Response(body)
      : Response.json(body);

/**
 * Stubs `fetch`: a string body is sent as text, a `Response` as-is, a function is called per request,
 * anything else is JSON; unknown URLs are 404s.
 */
export function stubFetch(routes: Readonly<Record<string, unknown>>) {
  const fetchMock = vi.fn<FetchLike>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!(url in routes))
      return Response.json(
        { error: { class: "not_found", message: url, retryable: false } },
        { status: 404 },
      );
    const route = routes[url];
    return toResponse(
      await (typeof route === "function" ? route(init) : route),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export type FetchMock = ReturnType<typeof stubFetch>;

/** The calls a stub saw to `url` with `method`. */
export const callsTo = (fetchMock: FetchMock, url: string, method = "GET") =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      String(input) === url && (init?.method ?? "GET") === method,
  );

/** The JSON body of the first such call. */
export const bodyOf = (
  fetchMock: FetchMock,
  url: string,
  method: string,
): unknown => {
  const [, init] = callsTo(fetchMock, url, method)[0] ?? [];
  return JSON.parse((init?.body as string | undefined) ?? "null") as unknown;
};

/** An API error response, as every non-2xx body is (proto ApiErrorBody). */
export const apiError = (status: number, errorClass: string, message: string) =>
  Response.json(
    { error: { class: errorClass, message, retryable: status >= 500 } },
    { status },
  );
