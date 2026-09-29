import { AttentionAck, FleetPauseState } from "@bayon/proto";
import { postJson } from "@/api/http";

// The kill switch's REST (M4 §12.1, §13.3). The API audits both, and answers the state
// after the call; the Fleet's `paused` (GET /fleet and the `fleet` topic) is what the header shows.

/** `POST /fleet/pause` or `POST /fleet/resume`; the same state again is `changed: false`. No body. */
export const setFleetPaused = (paused: boolean): Promise<FleetPauseState> =>
  postJson(`/fleet/${paused ? "pause" : "resume"}`, {}, FleetPauseState);

/**
 * `POST /fleet/attention/:sessionId/ack`: dismisses a finished session's error from the
 * strip for good, audited. Only an error exit can be dismissed — a stale session is live, and the
 * strip names its remedy instead — so the server refuses anything else as a conflict.
 */
export const ackAttention = (sessionId: string): Promise<AttentionAck> =>
  postJson(
    `/fleet/attention/${encodeURIComponent(sessionId)}/ack`,
    {},
    AttentionAck,
  );
