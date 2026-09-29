import {
  FindingView,
  GATES_TOPIC_LIMIT,
  GateRunAccepted,
  GateView,
  GatesPage,
  type ResolveFindingRequest,
} from "@bayon/proto";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { getJson, postJson } from "@/api/http";

/** The review queue: the `gates` topic and every gate or finding write refresh it by this prefix. */
export const GATES_KEY = ["gates"] as const;

/**
 * `GET /gates?state=running,failed&latest=1`, page after page, one project's with `project`. The
 * fleet's first page is what the `gates` topic sends (GATES_TOPIC_LIMIT rows), so a frame can stand
 * in for it; a project's never can (use-gates-feed.ts).
 */
const queuePath = (cursor: string | null, project?: string): string => {
  const params = new URLSearchParams({
    state: "running,failed",
    latest: "1",
    limit: String(GATES_TOPIC_LIMIT),
  });
  if (project !== undefined) params.set("project", project);
  if (cursor !== null) params.set("cursor", cursor);
  return `/gates?${params.toString()}`;
};

export const reviewQueueQuery = infiniteQueryOptions({
  queryKey: [...GATES_KEY, "queue"],
  queryFn: ({ pageParam, signal }) =>
    getJson(queuePath(pageParam), GatesPage, signal),
  initialPageParam: null as string | null,
  getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
});

/**
 * One project's review queue: the gates of its tickets. Its key is outside the fleet
 * queue's, so a `gates` snapshot is never written into it; a gate write's refresh of `["gates"]`
 * still reaches it.
 */
export const projectQueueQuery = (project: string) =>
  infiniteQueryOptions({
    queryKey: [...GATES_KEY, "project", project, "queue"],
    queryFn: ({ pageParam, signal }) =>
      getJson(queuePath(pageParam, project), GatesPage, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : null),
  });

/** The fleet's queue, or one project's. */
export const queueQuery = (project: string | undefined) =>
  project === undefined ? reviewQueueQuery : projectQueueQuery(project);

const segment = encodeURIComponent;

/** `POST /gates/:id/run`: the next attempt; 409 while one of its kind runs, 422 outside its status. */
export const rerunGate = (id: string): Promise<GateRunAccepted> =>
  postJson(`/gates/${segment(id)}/run`, {}, GateRunAccepted);

/** `POST /gates/:id/waive`: running | failed → waived, the reason shown forever; else 409. */
export const waiveGate = (id: string, reason: string): Promise<GateView> =>
  postJson(`/gates/${segment(id)}/waive`, { reason }, GateView);

/** `POST /findings/:id/resolve`: names the fixing run, which must work the finding's ticket (422). */
export const resolveFinding = (
  id: string,
  request: ResolveFindingRequest,
): Promise<FindingView> =>
  postJson(`/findings/${segment(id)}/resolve`, request, FindingView);

/** `POST /findings/:id/waive`: open → waived, the reason shown forever; else 409. */
export const waiveFinding = (
  id: string,
  reason: string,
): Promise<FindingView> =>
  postJson(`/findings/${segment(id)}/waive`, { reason }, FindingView);
