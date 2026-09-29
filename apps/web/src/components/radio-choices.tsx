import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

/**
 * One choice among `values`: a legend naming the group, and per value a radio named by its
 * label and described by its hint. The shape the QA mode, the docs source and delivery's mode and
 * moment all share.
 */
export function RadioChoices<T extends string>({
  legend,
  values,
  labels,
  hints,
  value,
  onChange,
}: {
  readonly legend: string;
  readonly values: readonly T[];
  readonly labels: Readonly<Record<T, string>>;
  readonly hints?: Readonly<Record<T, string>>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  const base = useId();
  const legendId = `${base}-legend`;
  return (
    <div className="flex flex-col gap-2">
      <div id={legendId} className="text-sm font-medium">
        {legend}
      </div>
      <RadioGroup<T>
        aria-labelledby={legendId}
        value={value}
        onValueChange={(next) => onChange(next)}
      >
        {values.map((option) => {
          const id = `${base}-${option}`;
          const hintId = `${id}-hint`;
          return (
            <div key={option} className="flex items-start gap-2">
              <RadioGroupItem
                id={id}
                value={option}
                aria-describedby={hints === undefined ? undefined : hintId}
                className="mt-0.5"
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <Label htmlFor={id} className="font-normal leading-5">
                  {labels[option]}
                </Label>
                {hints !== undefined && (
                  <span id={hintId} className="text-xs text-muted-foreground">
                    {hints[option]}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}
