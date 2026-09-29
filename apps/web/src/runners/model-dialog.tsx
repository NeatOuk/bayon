import type { RunnerModelView } from "@bayon/proto";
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
import {
  BLANK_FORM,
  TIERS,
  createRequestOf,
  formOf,
  patchRequestOf,
  type ModelForm,
} from "@/runners/model-form";
import { RUNNERS_KEY, createModel, patchModel } from "@/runners/runners-api";

/** One text field of the form. */
function TextField({
  label,
  value,
  hint,
  numeric = false,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly numeric?: boolean;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {({ id, describedBy }) => (
        <Input
          id={id}
          aria-describedby={describedBy}
          value={value}
          disabled={disabled}
          inputMode={numeric ? "decimal" : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Add or edit one of a runner's models. Adding names a new id and model string, which
 * the runner's adapter judges on the server; editing changes tier, effort, prices and context — the
 * model string is fixed once stored (its certificates are pinned to it). The server's refusal (the
 * one-active-per-tier rule, the adapter's verdict) is shown inline, and the dialog stays open.
 */
export function ModelDialog({
  runnerId,
  editing,
}: {
  readonly runnerId: string;
  /** The row to edit; absent to add one. */
  readonly editing?: RunnerModelView;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ModelForm>(BLANK_FORM);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (f: ModelForm) => {
      if (editing === undefined) {
        const request = createRequestOf(f);
        if (!request.ok) throw new Error(request.problem);
        return createModel(runnerId, request.value);
      }
      const request = patchRequestOf(f, editing);
      if (!request.ok) throw new Error(request.problem);
      return patchModel(runnerId, editing.id, request.value);
    },
    onSuccess: async (reply) => {
      setOpen(false);
      notify.success(
        reply.replaced.length === 0
          ? `Saved ${reply.model.id}`
          : `Saved ${reply.model.id}; it replaces ${reply.replaced.join(", ")} in its tier`,
      );
      await queryClient.invalidateQueries({ queryKey: RUNNERS_KEY });
    },
    onError: (error) => setProblem(error.message),
  });
  const set = (patch: Partial<ModelForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const adding = editing === undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setForm(editing === undefined ? BLANK_FORM : formOf(editing));
          setProblem(null);
          save.reset();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm" variant={adding ? "default" : "outline"}>
            {adding ? "Add model" : "Edit"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {adding ? `Add a model to ${runnerId}` : `Edit ${editing.id}`}
          </DialogTitle>
          <DialogDescription>
            One active model per tier: an active model you add takes its tier
            from the runner&apos;s own, and a second of yours is refused until
            you turn the first off. Prices are USD per million tokens; 0 is a
            price. Provider settings are changed only with frm config apply
            --yes.
          </DialogDescription>
        </DialogHeader>
        {adding && (
          <>
            <TextField
              label="Id"
              value={form.id}
              hint={`e.g. ${runnerId}.local`}
              onChange={(id) => set({ id })}
            />
            <TextField
              label="Model"
              value={form.model}
              hint="The model string the runner runs; its adapter decides what it may be."
              onChange={(model) => set({ model })}
            />
          </>
        )}
        <ChoiceField
          label="Tier"
          value={form.tier}
          options={TIERS}
          onChange={(tier) => set({ tier: tier ?? form.tier })}
        />
        <TextField
          label="Effort (optional)"
          value={form.effort}
          onChange={(effort) => set({ effort })}
        />
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label="Input price"
            numeric
            value={form.priceIn}
            onChange={(priceIn) => set({ priceIn })}
          />
          <TextField
            label="Output price"
            numeric
            value={form.priceOut}
            onChange={(priceOut) => set({ priceOut })}
          />
          <TextField
            label="Cache read price"
            numeric
            value={form.cacheRead}
            onChange={(cacheRead) => set({ cacheRead })}
          />
          <TextField
            label="Cache write price"
            numeric
            value={form.cacheWrite}
            onChange={(cacheWrite) => set({ cacheWrite })}
          />
        </div>
        <TextField
          label="Context (tokens, optional)"
          numeric
          value={form.context}
          onChange={(context) => set({ context })}
        />
        {problem !== null && (
          <p role="alert" className="text-sm text-destructive">
            {`Not saved: ${problem}`}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={save.isPending}
            onClick={() => {
              setProblem(null);
              save.mutate(form);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
