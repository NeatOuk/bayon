import type { ProjectAgentView, ProjectView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import {
  DescriptionItem,
  DescriptionList,
} from "@/components/description-list";
import { Loading } from "@/components/loading";
import { SectionTitle } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { humanize } from "@/components/status";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatIdle } from "@/fleet/fleet-model";
import {
  afterProjectWrite,
  setProjectPaused,
  setStaffApproval,
} from "@/ide/orchestrator-api";
import { PolicyEditor } from "@/pulses/policy-editor";
import { pulseAgentsQuery } from "@/pulses/pulse-api";
import { describeNextPulse } from "@/pulses/pulse-model";
import { RunNowButton } from "@/pulses/run-now-button";
import { projectHref } from "@/routing";

// The Orchestrator view's controls: the project's own pause, its staffing approval, a
// pulse now, and the pulse schedule. Each shows the server's state, never the one asked for, and a
// refusal in the server's words.

/** One control: its name (an h3, under the Controls panel's h2), what it does, and the control. */
function Control({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <SectionTitle as="h3" id={headingId}>
        {title}
      </SectionTitle>
      {children}
    </div>
  );
}

const Hint = ({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) => (
  <p id={id} className="text-sm text-muted-foreground">
    {children}
  </p>
);

const Refusal = ({ children }: { readonly children: string }) => (
  <p role="alert" className="text-sm text-destructive">
    {children}
  </p>
);

const PAUSE_ASK = {
  pause: {
    title: "Pause this project?",
    body:
      "Nothing new starts in it: its spawns and its sessions' next turns wait (queued " +
      "project_paused), and its orchestrator does not pulse. Running turns finish. Every other " +
      "project runs on. It stays paused until you resume it.",
    confirm: "Pause project",
  },
  resume: {
    title: "Resume this project?",
    body: "Admission's next recheck admits the spawns it queued, and its orchestrator pulses again.",
    confirm: "Resume project",
  },
} as const;

/** `POST /projects/:id/pause|resume`, confirmed either way, as the fleet's switch is. */
export function ProjectPauseControl({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [target, setTarget] = useState(true);
  const switchId = useId();
  const labelId = `${switchId}-label`;
  const hintId = `${switchId}-hint`;
  const mutation = useMutation({
    mutationFn: (paused: boolean) => setProjectPaused(project.id, paused),
    onSuccess: async (state) => {
      setAsking(false);
      await afterProjectWrite(queryClient, project.id, {
        paused: state.paused,
      });
    },
  });
  const ask = target ? PAUSE_ASK.pause : PAUSE_ASK.resume;
  return (
    <Control title="Pause project">
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          id={switchId}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          checked={project.paused}
          disabled={mutation.isPending}
          onCheckedChange={(next: boolean) => {
            mutation.reset();
            setTarget(next);
            setAsking(true);
          }}
        />
        <Label id={labelId} htmlFor={switchId}>
          Pause project
        </Label>
        <StatusBadge
          entity="pause"
          state={project.paused ? "paused" : "running"}
        />
      </div>
      <Hint id={hintId}>
        While paused, nothing new starts here: no spawn, no new turn, no pulse.
        Running turns finish.
      </Hint>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && (
            <Refusal>{`Not ${target ? "paused" : "resumed"}: ${mutation.error.message}`}</Refusal>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant={target ? "destructive" : "default"}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(target)}
            >
              {ask.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Control>
  );
}

/** `PATCH /projects/:id {staff_approval}`: a switch, written at once either way. */
export function StaffApprovalControl({
  project,
}: {
  readonly project: ProjectView;
}) {
  const queryClient = useQueryClient();
  const switchId = useId();
  const labelId = `${switchId}-label`;
  const hintId = `${switchId}-hint`;
  const mutation = useMutation({
    mutationFn: (on: boolean) => setStaffApproval(project.id, on),
    onSuccess: (state) =>
      afterProjectWrite(queryClient, project.id, {
        staff_approval: state.staff_approval,
      }),
  });
  return (
    <Control title="Require approval">
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          aria-labelledby={labelId}
          aria-describedby={hintId}
          checked={project.staff_approval}
          disabled={mutation.isPending}
          onCheckedChange={(next: boolean) => {
            mutation.reset();
            mutation.mutate(next);
          }}
        />
        <Label id={labelId} htmlFor={switchId}>
          Require approval
        </Label>
      </div>
      <Hint id={hintId}>
        When on, the orchestrator proposes each staffing below and no session
        starts until you approve it. Your own staffing never asks.
      </Hint>
      {mutation.isError && (
        <Refusal>{`Not changed: ${mutation.error.message}`}</Refusal>
      )}
    </Control>
  );
}

/** One pulse now (§9.7 manual), its command followed to the outcome or the refusal. */
export function WakeControl({ agent }: { readonly agent: ProjectAgentView }) {
  return (
    <Control title="Wake now">
      <Hint>
        One pulse now, outside the schedule. It skips the minimum gap, never the
        hourly cap. A paused fleet or project refuses it.
      </Hint>
      <RunNowButton
        agentId={agent.id}
        agentName={agent.name}
        label="Wake now"
      />
    </Control>
  );
}

/**
 * The pulse schedule (§9.7): the policy and next pulse from `GET /agents/pulse-policies`, edited
 * with the Pulses screen's `PolicyEditor`. Only an enabled orchestrator pulses, so only it has one.
 */
export function ScheduleControl({
  agent,
  project,
}: {
  readonly agent: ProjectAgentView;
  readonly project: string;
}) {
  const pulses = useQuery(pulseAgentsQuery);
  const policy = pulses.data?.items.find((item) => item.agent_id === agent.id);
  return (
    <Control title="Pulse schedule">
      {!agent.enabled && (
        <Hint>
          Disabled: it does not pulse, and has no schedule.{" "}
          <TextLink inline href={projectHref(project, "agents")}>
            Enable it in Agents.
          </TextLink>
        </Hint>
      )}
      {agent.enabled && pulses.isPending && (
        <Loading label="Loading the schedule…" />
      )}
      {agent.enabled && pulses.isError && (
        <QueryError
          title="The schedule is unavailable"
          error={pulses.error}
          onRetry={() => void pulses.refetch()}
        />
      )}
      {agent.enabled && pulses.data !== undefined && policy === undefined && (
        <Hint>Not scheduled.</Hint>
      )}
      {agent.enabled && policy !== undefined && (
        <>
          <DescriptionList>
            <DescriptionItem term="Mode">
              <Badge variant="outline">{humanize(policy.mode)}</Badge>
            </DescriptionItem>
            <DescriptionItem term="Next">
              {describeNextPulse(policy, pulses.dataUpdatedAt)}
            </DescriptionItem>
            <DescriptionItem term="Interval">
              {formatIdle(policy.interval_ms)}
            </DescriptionItem>
            <DescriptionItem term="Debounce">
              {formatIdle(policy.debounce_ms)}
            </DescriptionItem>
            <DescriptionItem term="Minimum gap">
              {formatIdle(policy.min_gap_ms)}
            </DescriptionItem>
            <DescriptionItem term="Most per hour">
              {policy.max_per_hour}
            </DescriptionItem>
            <DescriptionItem term="Jitter">{`${policy.jitter_pct}%`}</DescriptionItem>
          </DescriptionList>
          <div>
            <PolicyEditor agent={policy} />
          </div>
        </>
      )}
    </Control>
  );
}
