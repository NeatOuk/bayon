import type { FleetRow, ProjectAgentView, ProjectView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Id } from "@/components/id";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { humanize } from "@/components/status";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { AddAgentDialog } from "@/ide/add-agent-dialog";
import { slotsOf } from "@/ide/agent-form";
import { afterAgentWrite, patchAgent } from "@/ide/agents-api";
import { LiveState, type TabHref } from "@/ide/live-state";
import { useProjectFleet } from "@/ide/project-fleet";
import { projectHref, type IdeView } from "@/routing";

// The IDE's Agents view: the project's agents with their live state, and the operator's
// three moves on them — add one (a builder, reviewer or orchestrator on any runner), enable or disable one, and
// set how many sessions it may run at once. Every write is `PATCH /agents/:id` or
// `POST /projects/:id/agents`; nothing deletes an agent.

const NO_ROWS: readonly FleetRow[] = [];

export function AgentsView({
  project,
  view,
}: {
  readonly project: ProjectView;
  readonly view: IdeView;
}) {
  const { byAgent } = useProjectFleet(project.id);
  const tabHref: TabHref = (tab) => projectHref(project.id, view, tab);
  return (
    <PageContainer>
      <PageHeader
        title="Agents"
        meta={
          <p className="max-w-prose text-sm">
            Nothing deletes an agent: disable one to retire it. A disabled agent
            takes no new work, and what it is running finishes. Max concurrency
            0 holds an agent the same way.
          </p>
        }
        actions={<AddAgentDialog project={project} />}
      />
      {project.agents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No agents yet</EmptyTitle>
            <EmptyDescription>
              Add a builder or a reviewer to staff this project&apos;s tickets,
              and an orchestrator to staff them for you.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul aria-label="project agents" className="flex flex-col gap-3">
          {project.agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              rows={byAgent.get(agent.name) ?? NO_ROWS}
              tabHref={tabHref}
            />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

function AgentRow({
  agent,
  rows,
  tabHref,
}: {
  readonly agent: ProjectAgentView;
  readonly rows: readonly FleetRow[];
  readonly tabHref: TabHref;
}) {
  const nameId = useId();
  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-xs md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TextLink
            id={nameId}
            href={tabHref({ kind: "agent", id: agent.id })}
            className="font-head"
          >
            {agent.name}
          </TextLink>
          <Badge variant="outline">{humanize(agent.kind)}</Badge>
          <Id value={agent.runner_id} className="text-xs" />
          {agent.model !== null && (
            <span
              aria-label="model"
              className="font-mono text-xs text-muted-foreground"
            >
              {agent.model}
            </span>
          )}
        </div>
        <LiveState agent={agent} rows={rows} tabHref={tabHref} />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <EnabledSwitch agent={agent} nameId={nameId} />
        <ConcurrencyForm agent={agent} nameId={nameId} />
      </div>
    </li>
  );
}

/**
 * Enable or disable one agent. Enabling writes at once; disabling asks first. The switch shows the
 * server's state, never the one asked for, and a refusal says why.
 */
function EnabledSwitch({
  agent,
  nameId,
}: {
  readonly agent: ProjectAgentView;
  /** The agent's name in its row: the switch is named "<agent> Enabled". */
  readonly nameId: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const switchId = useId();
  const labelId = `${switchId}-label`;
  const mutation = useMutation({
    mutationFn: (enabled: boolean) => patchAgent(agent.id, { enabled }),
    onSuccess: async (view) => {
      setConfirming(false);
      await afterAgentWrite(queryClient, view);
    },
  });
  const asked = mutation.variables;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          aria-labelledby={`${nameId} ${labelId}`}
          checked={agent.enabled}
          disabled={mutation.isPending}
          onCheckedChange={(next: boolean) => {
            mutation.reset();
            if (next) mutation.mutate(true);
            else setConfirming(true);
          }}
        />
        <Label id={labelId} htmlFor={switchId}>
          Enabled
        </Label>
      </div>
      {mutation.isError && asked === true && (
        <p role="alert" className="max-w-60 text-sm text-destructive">
          {`Not enabled: ${mutation.error.message}`}
        </p>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`Disable ${agent.name}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              It takes no new work: admission refuses its spawns until it is
              enabled again. A session it is running finishes. Nothing is
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && asked === false && (
            <p role="alert" className="text-sm text-destructive">
              {`Not disabled: ${mutation.error.message}`}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(false)}
            >
              {`Disable ${agent.name}`}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** How many sessions the agent may run at once: a whole number, saved when it differs. */
function ConcurrencyForm({
  agent,
  nameId,
}: {
  readonly agent: ProjectAgentView;
  /** The agent's name in its row: the field is named "<agent> Max concurrency". */
  readonly nameId: string;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const inputId = useId();
  const labelId = `${inputId}-label`;
  const mutation = useMutation({
    mutationFn: (slots: number) =>
      patchAgent(agent.id, { max_concurrency: slots }),
    onSuccess: async (view) => {
      setDraft(null);
      await afterAgentWrite(queryClient, view);
    },
  });
  const text = draft ?? String(agent.max_concurrency);
  const slots = slotsOf(text);
  const changed = slots !== null && slots !== agent.max_concurrency;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) mutation.mutate(slots);
      }}
    >
      <Label id={labelId} htmlFor={inputId}>
        Max concurrency
      </Label>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          aria-labelledby={`${nameId} ${labelId}`}
          aria-invalid={slots === null}
          value={text}
          onChange={(event) => {
            mutation.reset();
            setDraft(event.target.value);
          }}
          className="w-20"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!changed || mutation.isPending}
        >
          Set
        </Button>
      </div>
      {slots === null && (
        <p className="text-sm text-destructive">A whole number, 0 or more.</p>
      )}
      {mutation.isError && (
        <p role="alert" className="max-w-60 text-sm text-destructive">
          {`Not set: ${mutation.error.message}`}
        </p>
      )}
    </form>
  );
}
