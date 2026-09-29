import type { ReactNode } from "react";
import { Field } from "@/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Choice {
  readonly value: string | null;
  readonly label: string;
}

/**
 * A labelled registry Select over `options` (ids from the API, never typed). `none`, when given, is
 * a first choice worth null: the field left to its default. `hint` reads under it (Field's).
 */
export function ChoiceField({
  label,
  value,
  none,
  options,
  hint,
  disabled = false,
  className,
  onChange,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly none?: string;
  readonly options: readonly string[];
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onChange: (value: string | null) => void;
}) {
  const items: readonly Choice[] = [
    ...(none === undefined ? [] : [{ value: null, label: none }]),
    ...options.map((option) => ({ value: option, label: option })),
  ];
  return (
    <Field label={label} hint={hint} className={className}>
      {({ id, labelId, describedBy }) => (
        <Select
          items={items}
          value={value}
          disabled={disabled}
          onValueChange={(next: string | null) => onChange(next)}
        >
          <SelectTrigger
            id={id}
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value ?? ""} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Field>
  );
}
