import { ADDABLE_AGENT_KINDS, type AddableAgentKind } from "@bayon/core";
import type { CreateProjectAgentRequest, ProjectView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";
import { ChoiceField } from "@/components/choice-field";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/components/ui/toast";
import { addProjectAgent, afterAgentWrite } from "@/ide/agents-api";
import { slotsOf } from "@/ide/agent-form";
import { RunnerField, UncertifiedWarning } from "@/ide/runner-field";
import { runnersQuery } from "@/runners/runners-api";

interface Form {
  readonly kind: AddableAgentKind;
  readonly runnerId: string | null;
  /** Blank: the column's default, 1. */
  readonly slots: string;
}

const BLANK: Form = { kind: "builder", runnerId: null, slots: "" };

const isKind = (value: string | null): value is AddableAgentKind =>
  (ADDABLE_AGENT_KINDS as readonly (string | null)[]).includes(value);

/** The POST body, or null while the form cannot be sent. */
function requestOf(form: Form): CreateProjectAgentRequest | null {
  if (form.runnerId === null) return null;
  if (form.slots.trim() === "")
    return { kind: form.kind, runner_id: form.runnerId };
  const slots = slotsOf(form.slots);
  return slots === null
    ? null
    : { kind: form.kind, runner_id: form.runnerId, max_concurrency: slots };
}

/**
 * Add agent: a builder, reviewer or orchestrator for this project, on a
 * runner the operator picks from `GET /runners`, each shown with its certification on `local` so an
 * uncertified pick is seen before it is made. The write never waits on certification:
 * `POST /projects/:id/agents` is the real gate, and the dialog shows what it refuses — a second
 * enabled orchestrator among them. Added, it closes and a toast names the new agent.
 */
export function AddAgentDialog({ project }: { readonly project: ProjectView }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const runners = useQuery({ ...runnersQuery, enabled: open });
  const add = useMutation({
    mutationFn: (request: CreateProjectAgentRequest) =>
      addProjectAgent(project.id, request),
    onSuccess: async (agent) => {
      setOpen(false);
      notify.success(`Added ${agent.name}`);
      await afterAgentWrite(queryClient, agent);
    },
  });
  const slotsId = useId();
  const request = requestOf(form);
  const set = (patch: Partial<Form>) =>
    setForm((current) => ({ ...current, ...patch }));
  const picked = runners.data?.runners.find((r) => r.id === form.runnerId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setForm(BLANK);
          add.reset();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <PlusIcon />
            Add agent
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Add an agent to ${project.name}`}</DialogTitle>
          <DialogDescription>
            A builder, a reviewer or an orchestrator, on any registered runner.
            It runs where the project&apos;s other agents run, and nothing
            deletes it later: disable it to retire it. A project has at most one
            enabled orchestrator.
          </DialogDescription>
        </DialogHeader>
        <ChoiceField
          label="Kind"
          value={form.kind}
          options={ADDABLE_AGENT_KINDS}
          onChange={(kind) => {
            if (isKind(kind)) set({ kind });
          }}
        />
        {runners.isError ? (
          <QueryError
            title="The runners are unavailable"
            error={runners.error}
            onRetry={() => void runners.refetch()}
          />
        ) : (
          <RunnerField
            runners={runners.data?.runners ?? []}
            loading={runners.isPending}
            value={form.runnerId}
            onChange={(runnerId) => set({ runnerId })}
          />
        )}
        {picked !== undefined && <UncertifiedWarning runner={picked} />}
        <div className="flex flex-col gap-1">
          <Label htmlFor={slotsId}>Max concurrency (optional)</Label>
          <Input
            id={slotsId}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            placeholder="1"
            aria-invalid={
              form.slots.trim() !== "" && slotsOf(form.slots) === null
            }
            value={form.slots}
            onChange={(event) => set({ slots: event.target.value })}
          />
        </div>
        {add.isError && (
          <p role="alert" className="text-sm text-destructive">
            {`Not added: ${add.error.message}`}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={request === null || add.isPending}
            onClick={() => {
              if (request !== null) add.mutate(request);
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
