import type { RunnerView } from "@bayon/proto";
import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CERTIFICATION_EXECUTOR,
  certificationLabel,
  certificationOn,
  type CertificationState,
} from "@/ide/runner-certification";

// The runner pick an agent is added on, shared by the Agents view's Add agent dialog
// and the Orchestrator view's Add orchestrator: each runner with its certification on
// `local`, so an uncertified pick is seen before it is made; the write never waits on it.

/** Why a pick is not certified, in the warning's words. */
const WHY: Readonly<Record<Exclude<CertificationState, "certified">, string>> =
  {
    "never run": "never run",
    "not certified": "its run did not pass",
    decertified: "decertified",
  };

/** Shown, never blocking: `POST /projects/:id/agents` adds an agent on an uncertified runner. */
export function UncertifiedWarning({
  runner,
}: {
  readonly runner: RunnerView;
}) {
  const state = certificationOn(runner, CERTIFICATION_EXECUTOR);
  if (state === "certified") return null;
  return (
    <p className="text-sm text-muted-foreground">
      {`warning: ${runner.id} is not certified on ${CERTIFICATION_EXECUTOR} (${WHY[state]}): the agent is still added, but unattended work needs it certified.`}
    </p>
  );
}

/** The runner Select: each runner with its certification on `local`; a disabled one cannot be picked. */
export function RunnerField({
  runners,
  loading,
  value,
  onChange,
}: {
  readonly runners: readonly RunnerView[];
  readonly loading: boolean;
  readonly value: string | null;
  readonly onChange: (runnerId: string | null) => void;
}) {
  const labelId = useId();
  const items = runners.map((runner) => ({
    value: runner.id,
    label: runner.id,
  }));
  return (
    <div className="flex flex-col gap-1">
      <Label id={labelId}>Runner</Label>
      <Select
        items={items}
        value={value}
        disabled={loading}
        onValueChange={(next: string | null) => onChange(next)}
      >
        <SelectTrigger aria-labelledby={labelId} className="w-full">
          <SelectValue
            placeholder={loading ? "loading the runners…" : "pick a runner"}
          />
        </SelectTrigger>
        <SelectContent>
          {runners.map((runner) => (
            <SelectItem
              key={runner.id}
              value={runner.id}
              disabled={!runner.enabled}
            >
              <span className="flex flex-col">
                <span className="font-mono">{runner.id}</span>
                <span className="text-xs text-muted-foreground">
                  {runner.enabled
                    ? certificationLabel(runner, CERTIFICATION_EXECUTOR)
                    : "disabled: not offered"}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
