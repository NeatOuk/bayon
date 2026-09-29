import { BindingRole, ModelTier } from "@bayon/core";
import { PutRoleBinding, type RoleBindingView } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ChoiceField } from "@/components/choice-field";
import { Field } from "@/components/field";
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
import { notify } from "@/components/ui/toast";
import { ROLE_BINDINGS_KEY, putRoleBinding } from "@/settings/roles-api";

/** What the dialog edits: picked ids (null = none) and the typed profile (blank = none). */
export interface BindingForm {
  readonly runner_id: string | null;
  readonly model_tier: string | null;
  readonly executor_id: string | null;
  readonly profile_id: string;
  readonly fallback_runner_id: string | null;
  readonly require_distinct_from: string | null;
}

export const formOf = (binding: RoleBindingView | undefined): BindingForm => ({
  runner_id: binding?.runner_id ?? null,
  model_tier: binding?.model_tier ?? null,
  executor_id: binding?.executor_id ?? null,
  profile_id: binding?.profile_id ?? "",
  fallback_runner_id: binding?.fallback_runner_id ?? null,
  require_distinct_from: binding?.require_distinct_from ?? null,
});

const blankToNull = (text: string): string | null =>
  text.trim() === "" ? null : text.trim();

/** The PUT body from the form, or null when PutRoleBinding refuses it (no runner, a bad id). */
export function bindingRequest(
  role: BindingRole,
  form: BindingForm,
): PutRoleBinding | null {
  const parsed = PutRoleBinding.safeParse({
    role,
    runner_id: form.runner_id,
    model_tier: form.model_tier,
    executor_id: form.executor_id,
    profile_id: blankToNull(form.profile_id),
    fallback_runner_id: form.fallback_runner_id,
    require_distinct_from: form.require_distinct_from,
  });
  return parsed.success ? parsed.data : null;
}

function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      {({ id }) => (
        <Input
          id={id}
          value={value}
          maxLength={64}
          placeholder="none"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** A list of ids that always holds the bound one, even when no row names it any more. */
const withBound = (
  ids: readonly string[],
  bound: string | null,
): readonly string[] =>
  bound === null || ids.includes(bound) ? ids : [...ids, bound];

/**
 * Binds or rebinds one role (PUT /role-bindings): the runner, and optionally the model tier, the
 * executor (from GET /executors), the profile, a fallback runner and the role it must differ from
 * (§9.8). The server checks the ids exist; certification is checked when a gate runs, so it is not
 * refused here.
 */
export function RoleBindingDialog({
  role,
  binding,
  runners,
  executors,
}: {
  readonly role: BindingRole;
  readonly binding: RoleBindingView | undefined;
  readonly runners: readonly string[];
  readonly executors: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<BindingForm>(() => formOf(binding));
  const [formError, setFormError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: putRoleBinding,
    onSuccess: (saved) => {
      setOpen(false);
      notify.success(`${saved.role} bound to ${saved.runner_id}`);
      void queryClient.invalidateQueries({ queryKey: ROLE_BINDINGS_KEY });
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setForm(formOf(binding));
      setFormError(null);
      save.reset();
    }
  }

  const set = (patch: Partial<BindingForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  function submit() {
    const request = bindingRequest(role, form);
    if (request === null) {
      setFormError("Pick a runner; typed ids are 1 to 64 characters.");
      return;
    }
    setFormError(null);
    save.mutate(request);
  }

  const error = formError ?? (save.isError ? save.error.message : null);
  const choices = withBound(runners, form.runner_id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" aria-label={`Bind ${role}`}>
            {binding === undefined ? "Bind" : "Edit"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Bind ${role}`}</DialogTitle>
          <DialogDescription>
            The runner that works this role. Tier, executor and profile default
            to the run class's and the agent's when left empty.
          </DialogDescription>
        </DialogHeader>
        <ChoiceField
          label="Runner"
          value={form.runner_id}
          none="pick a runner"
          options={choices}
          onChange={(runner_id) =>
            set({
              runner_id,
              // A runner cannot be its own fallback.
              ...(runner_id !== null && runner_id === form.fallback_runner_id
                ? { fallback_runner_id: null }
                : {}),
            })
          }
        />
        <ChoiceField
          label="Model tier"
          value={form.model_tier}
          none="default"
          options={ModelTier.options}
          onChange={(model_tier) => set({ model_tier })}
        />
        <ChoiceField
          label="Executor"
          value={form.executor_id}
          none="default"
          options={withBound(executors, form.executor_id)}
          onChange={(executor_id) => set({ executor_id })}
        />
        <TextField
          label="Profile"
          value={form.profile_id}
          onChange={(profile_id) => set({ profile_id })}
        />
        <ChoiceField
          label="Fallback runner"
          value={form.fallback_runner_id}
          none="none"
          options={choices.filter((runner) => runner !== form.runner_id)}
          onChange={(fallback_runner_id) => set({ fallback_runner_id })}
        />
        <ChoiceField
          label="Must differ from"
          value={form.require_distinct_from}
          none="no rule"
          options={BindingRole.options.filter((other) => other !== role)}
          onChange={(require_distinct_from) => set({ require_distinct_from })}
        />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={save.isPending}>
            Save binding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
