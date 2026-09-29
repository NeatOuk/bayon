import type { Fleet } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { fleetQuery } from "@/api/queries";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setFleetPaused } from "@/fleet/fleet-control-api";
import { useFleet } from "@/fleet/use-fleet";

const ASK = {
  pause: {
    title: "Pause the fleet?",
    body:
      "New spawns and new turns wait (queued fleet_paused); turns in flight and hand-off " +
      "packets finish. The pulse scheduler freezes and no review launches. The fleet stays " +
      "paused until you resume it.",
    confirm: "Pause fleet",
  },
  resume: {
    title: "Resume the fleet?",
    body: "Admission's next recheck admits the spawns it queued; pulses and reviews start again.",
    confirm: "Resume fleet",
  },
} as const;

/**
 * The top bar's kill switch (M4 §13.3): `fleet.paused` live from the fleet topic, toggled
 * only after a confirmation. The switch shows the server's state, never the one asked for, and the
 * state is in words beside it. Below `lg` the "Pause fleet" label is visually hidden ( * the bar stays one row at 320px); it is still the switch's name.
 */
export function PauseSwitch() {
  const fleet = useFleet();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(true);
  const switchId = useId();
  const labelId = `${switchId}-label`;
  const mutation = useMutation({
    mutationFn: setFleetPaused,
    onSuccess: (state) => {
      queryClient.setQueryData(
        fleetQuery.queryKey,
        (current: Fleet | undefined) =>
          current && { ...current, paused: state.paused },
      );
      setOpen(false);
    },
  });
  const paused = fleet.data?.paused;
  const ask = target ? ASK.pause : ASK.resume;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Switch
        size="sm"
        id={switchId}
        aria-labelledby={labelId}
        checked={paused === true}
        disabled={paused === undefined || mutation.isPending}
        onCheckedChange={(next: boolean) => {
          mutation.reset();
          setTarget(next);
          setOpen(true);
        }}
      />
      <Label id={labelId} htmlFor={switchId} className="max-lg:sr-only">
        Pause fleet
      </Label>
      <p
        role="status"
        aria-live="polite"
        className="min-w-0 truncate text-sm whitespace-nowrap"
      >
        {paused === undefined ? (
          <span className="text-muted-foreground">Fleet state unknown</span>
        ) : (
          <StatusBadge
            entity="pause"
            state={paused ? "paused" : "running"}
            label={paused ? "Fleet paused" : "Fleet running"}
          />
        )}
      </p>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {mutation.isError && (
            <p role="alert" className="text-sm text-destructive">
              {`Not ${target ? "paused" : "resumed"}: ${mutation.error.message}`}
            </p>
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
    </div>
  );
}
