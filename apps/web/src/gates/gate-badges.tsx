import type { GateView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { sessionQuery } from "@/api/queries";
import { Id } from "@/components/id";
import { gateStatus } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { reviewerOf, type GateFacts } from "@/gates/gate-model";
import { FLEET_RECORD_LINKS, type RecordLinks } from "@/routing";

/**
 * A gate's state as the status map reads it (status.ts): passed is the one green; a failure says
 * whose it was — findings are danger, a reviewer's own failure a warning, a round the ticket moved
 * past neutral — so the three never read alike.
 */
export function GateStateBadge({
  gate,
}: {
  readonly gate: Pick<GateFacts, "state" | "reason">;
}) {
  return <StatusBadge status={gateStatus(gate)} />;
}

/** The runner of a reviewer that has no evidence yet (running, or failed before it had any). */
function SessionRunner({ sessionId }: { readonly sessionId: string }) {
  const session = useQuery(sessionQuery(sessionId));
  return session.data === undefined ? null : (
    <Id value={session.data.runner_id} />
  );
}

/**
 * The reviewer: its runner, its flags (single-runner review, fallback, base drift), its session,
 * linked by `links` (a session tab inside the IDE).
 */
export function ReviewerFacts({
  gate,
  links = FLEET_RECORD_LINKS,
}: {
  readonly gate: Pick<GateView, "evidence" | "session_id" | "state">;
  readonly links?: RecordLinks;
}) {
  const reviewer = reviewerOf(gate.evidence);
  const sessionId = gate.session_id;
  return (
    <span className="flex flex-wrap items-center gap-1 text-sm">
      {reviewer !== null ? (
        <Id value={reviewer.runner} />
      ) : (
        sessionId !== null && <SessionRunner sessionId={sessionId} />
      )}
      {reviewer?.flags.map((flag) => (
        <Badge key={flag} variant="secondary">
          {flag}
        </Badge>
      ))}
      {sessionId !== null && (
        <TextLink href={links.session(sessionId)}>
          {gate.state === "running" ? "live reviewer" : "reviewer session"}
        </TextLink>
      )}
    </span>
  );
}
