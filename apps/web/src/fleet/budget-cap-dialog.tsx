import type { Fleet } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { fleetQuery, putBudgetCap } from "@/api/queries";
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
import { formatUsd } from "@/fleet/fleet-model";

type ParsedCap =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string };

/** The edit dialog's own check, before the amount ever reaches the server. */
function parseCap(raw: string): ParsedCap {
  const trimmed = raw.trim();
  if (trimmed === "")
    return { ok: false, message: "Enter an amount, or choose No cap." };
  const value = Number(trimmed);
  if (!Number.isFinite(value))
    return { ok: false, message: "Enter a valid number." };
  if (value < 0) return { ok: false, message: "Enter a non-negative amount." };
  return { ok: true, value };
}

const inputFor = (capUsd: number | null): string =>
  capUsd === null ? "" : String(capUsd);

/** The Fleet budget bar's edit control (§12.1): sets or clears `settings.budget.daily_cap_usd`. */
export function BudgetCapDialog({
  capUsd,
}: {
  readonly capUsd: number | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(() => inputFor(capUsd));
  const [formError, setFormError] = useState<string | null>(null);
  const inputId = useId();

  const mutation = useMutation({
    mutationFn: putBudgetCap,
    onSuccess: (saved) => {
      queryClient.setQueryData(
        fleetQuery.queryKey,
        (fleet: Fleet | undefined) =>
          fleet && { ...fleet, budget: { ...fleet.budget, ...saved } },
      );
      setOpen(false);
      notify.success(
        "Budget cap saved",
        saved.daily_cap_usd === null
          ? "No daily cap: the Fleet no longer warns on spend."
          : `The Fleet warns once today's spend passes ${formatUsd(saved.daily_cap_usd)}.`,
      );
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setInput(inputFor(capUsd));
      setFormError(null);
      mutation.reset();
    }
  }

  function save() {
    const parsed = parseCap(input);
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    setFormError(null);
    mutation.mutate(parsed.value);
  }

  function clear() {
    setFormError(null);
    mutation.mutate(null);
  }

  const errorMessage =
    formError ?? (mutation.isError ? mutation.error.message : null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="xs">
            Edit cap
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Daily budget cap</DialogTitle>
          <DialogDescription>
            The Fleet warns once today&apos;s spend passes this amount.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor={inputId}>Cap (USD)</Label>
          <Input
            id={inputId}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            placeholder="No cap"
            value={input}
            aria-invalid={errorMessage !== null}
            onChange={(event) => setInput(event.target.value)}
          />
          {errorMessage !== null && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={clear}
            disabled={mutation.isPending}
          >
            No cap
          </Button>
          <Button onClick={save} disabled={mutation.isPending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
