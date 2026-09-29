import type { ExecutorView } from "@bayon/proto";
import { StatusBadge } from "@/components/status-badge";
import { CheckHealth } from "@/executors/check-health";
import { DetailList } from "@/executors/detail-list";
import { formatTime } from "@/lib/format";
import { Panel } from "@/tickets/panel";

/**
 * One `executors` row (§6, §6.1) as the supervisor keeps it: kind, trust, egress, slots in use
 * against its slots, its last health check with what it measured, and its config (hosts, paths and
 * limits, never a secret, §14).
 */
export function ExecutorCard({
  executor,
  busy,
}: {
  readonly executor: ExecutorView;
  /** Live sessions on it (the fleet's slots); null when unknown. */
  readonly busy: number | null;
}) {
  return (
    <Panel label={executor.id} title={executor.id}>
      <div
        role="group"
        aria-label="executor status"
        className="flex flex-wrap items-center gap-2 text-sm"
      >
        <StatusBadge entity="health" state={executor.health} />
        <StatusBadge entity="trust" state={executor.trust} />
        {!executor.enabled && <StatusBadge entity="enabled" state="disabled" />}
        <span>{executor.kind}</span>
        <span>{`egress ${executor.egress_policy}`}</span>
        <span>{`${busy ?? "?"} of ${executor.slots} slots in use`}</span>
      </div>
      {!executor.enabled && (
        <p className="text-sm">
          {
            "Out of service: admission refuses new sessions here, and any still running finish where they are. Its certifications are kept. Put it back with "
          }
          <span className="font-mono">{`frm executor enable ${executor.id}`}</span>
          {" — a config row changes only from a shell (§9.5)."}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {executor.health_checked_at === null
          ? "Health never checked."
          : `Health checked ${formatTime(executor.health_checked_at)} UTC.`}
      </p>
      <DetailList
        title="Health detail"
        value={executor.health_detail}
        empty="No health detail recorded."
      />
      <DetailList
        title="Config"
        value={executor.config}
        empty="No config, or it does not parse."
      />
      <CheckHealth executorId={executor.id} />
    </Panel>
  );
}
