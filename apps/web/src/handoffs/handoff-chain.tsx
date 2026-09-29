import type { HandoffReason, HandoffView } from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { handoffQuery } from "@/handoffs/handoff-api";
import { Markdown } from "@/markdown/markdown";
import { sessionHref } from "@/routing";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

// §12.3 TICKET: the hand-off chain (§7), each hand-off's packet a click away.

function SessionLink({
  id,
  none,
}: {
  readonly id: string | null;
  readonly none: string;
}) {
  return id === null ? (
    <span>{none}</span>
  ) : (
    <TextLink href={sessionHref(id)}>
      <Id value={id} />
    </TextLink>
  );
}

/** Why each hand-off happened, as the operator reads it. */
const REASON: Readonly<Record<HandoffReason, string>> = {
  context_ceiling: "Context full",
  turn_ceiling: "Turn limit reached",
  budget: "Budget reached",
  phase_change: "Next phase",
  role_change: "Role changed",
  human_release: "Released by you",
  session_death: "Session died",
  operator: "Handed off by you",
  agent_request: "The agent asked",
  stale_session: "Session went silent",
};

const reasonText = (reason: string): string =>
  (REASON as Readonly<Record<string, string>>)[reason] ?? humanize(reason);

const acceptance = (handoff: HandoffView): string =>
  handoff.accepted_at !== null
    ? "picked up"
    : handoff.quality === "writing"
      ? "being written"
      : "waiting to be picked up";

export function HandoffChain({
  handoffs,
}: {
  readonly handoffs: readonly HandoffView[];
}) {
  return (
    <Panel label="hand-offs" title="Hand-off chain">
      {handoffs.length === 0 ? (
        <Muted>No hand-offs yet.</Muted>
      ) : (
        <ol className="flex flex-col gap-2 text-sm">
          {handoffs.map((handoff, index) => (
            <li key={handoff.id}>
              <Collapsible>
                <div className="flex flex-wrap items-center gap-2">
                  <span>{`#${index + 1} ${reasonText(handoff.reason)}`}</span>
                  <SessionLink id={handoff.from_session_id} none="—" />
                  <span>→</span>
                  <SessionLink id={handoff.to_session_id} none="no one yet" />
                  {/* core's HandoffQuality: `writing` is not takeable yet; `degraded` lost the
                      agent's own judgement. */}
                  <StatusBadge entity="handoff" state={handoff.quality} />
                  <span>{acceptance(handoff)}</span>
                  <CollapsibleTrigger
                    render={
                      <Button variant="outline" size="sm">
                        note
                      </Button>
                    }
                  />
                </div>
                {handoff.goal_line !== null && (
                  <p className="text-muted-foreground">{handoff.goal_line}</p>
                )}
                <CollapsibleContent>
                  <HandoffPacket id={handoff.id} />
                </CollapsibleContent>
              </Collapsible>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function PacketSection({
  title,
  markdown,
}: {
  readonly title: string;
  readonly markdown: string | null;
}) {
  if (markdown === null || markdown === "") return null;
  return (
    <>
      <SectionTitle as="h3">{title}</SectionTitle>
      <Markdown markdown={markdown} />
    </>
  );
}

/** `GET /handoffs/:id`: loaded when the packet is opened. */
function HandoffPacket({ id }: { readonly id: string }) {
  const packet = useQuery(handoffQuery(id));
  if (packet.isPending) return <Loading label="Loading the hand-off note…" />;
  if (packet.isError)
    return (
      <QueryError
        title="The hand-off note is unavailable"
        error={packet.error}
        onRetry={() => void packet.refetch()}
      />
    );
  const p = packet.data;
  const phases =
    p.phase_from === null && p.phase_to === null
      ? ""
      : ` · ${p.phase_from ?? "?"} → ${p.phase_to ?? "?"}`;
  const size = p.tokens_est === null ? "" : ` · ~${p.tokens_est} tokens`;
  return (
    <div
      aria-label={`packet ${id}`}
      className="mt-2 flex flex-col gap-1 border-l pl-3"
    >
      <p className="font-mono text-xs break-all">{`${p.packet_path}${size}${phases}`}</p>
      <PacketSection title="Decisions" markdown={p.decisions_md} />
      <PacketSection title="Traps" markdown={p.traps_md} />
      <PacketSection title="Next steps" markdown={p.next_steps_md} />
      <PacketSection title="Open questions" markdown={p.open_questions_md} />
      {p.pointers.length > 0 && (
        <ul className="font-mono text-xs">
          {p.pointers.map((pointer) => (
            <li key={pointer}>{pointer}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
