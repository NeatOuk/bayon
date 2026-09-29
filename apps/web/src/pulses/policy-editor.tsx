import {
  PulseMode,
  type AgentPulse,
  type PulsePolicyPatch,
} from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { humanize } from "@/components/status";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  POLICY_FIELDS,
  draftOf,
  patchOf,
  type PolicyDraft,
  type PolicyField,
} from "@/pulses/policy-form";
import { patchPulsePolicy, pulseAgentsQuery } from "@/pulses/pulse-api";

/** `PATCH /agents/:id/pulse-policy` (§9.7): only the changed fields are sent. */
export function PolicyEditor({ agent }: { readonly agent: AgentPulse }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftOf(agent));
  const [formError, setFormError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: PulsePolicyPatch) =>
      patchPulsePolicy(agent.agent_id, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: pulseAgentsQuery.queryKey,
      });
      setOpen(false);
      notify.success(
        `Pulse policy saved for ${agent.name}`,
        "The scheduler picks it up on its next tick.",
      );
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setDraft(draftOf(agent));
      setFormError(null);
      save.reset();
    }
  }

  function submit() {
    const result = patchOf(agent, draft);
    if (!result.ok) {
      setFormError(result.message);
      return;
    }
    setFormError(null);
    save.mutate(result.patch);
  }

  const setValue = (key: PolicyField, value: string) =>
    setDraft((d) => ({ ...d, values: { ...d.values, [key]: value } }));
  const errorMessage = formError ?? (save.isError ? save.error.message : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            Edit policy
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Pulse policy · ${agent.name}`}</DialogTitle>
          <DialogDescription>
            The scheduler picks a change up on its next tick.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <ToggleGroup
            aria-label="mode"
            value={[draft.mode]}
            onValueChange={(values) => {
              const mode = PulseMode.safeParse(values[0]);
              if (mode.success) setDraft((d) => ({ ...d, mode: mode.data }));
            }}
          >
            {PulseMode.options.map((mode) => (
              <ToggleGroupItem key={mode} value={mode}>
                {humanize(mode)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {POLICY_FIELDS.map((field) => (
            <PolicyInput
              key={field.key}
              label={field.label}
              value={draft.values[field.key]}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}
          {errorMessage !== null && (
            <p
              role="alert"
              className="text-sm whitespace-pre-wrap text-destructive"
            >
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={save.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PolicyInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min="0"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
