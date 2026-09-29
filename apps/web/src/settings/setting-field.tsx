import { OPERATOR_SETTINGS, type OperatorSettingDef } from "@bayon/core";
import type { OperatorSettingView } from "@bayon/proto";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatMs } from "@/settings/settings-form";

const UNIT_LABEL: Readonly<Record<OperatorSettingDef["unit"], string>> = {
  ms: " (ms)",
  percent: " (%)",
  count: "",
  hour: "",
  flag: "",
  mask: "",
};

/** A value as the hint says it: on/off, ms with its reading, or the number. */
function shown(def: OperatorSettingDef, value: number | null): string {
  if (value === null) return "unset";
  if (def.unit === "flag") return value === 1 ? "on" : "off";
  if (def.offAtZero === true && value === 0) return "off";
  if (def.unit === "ms") return `${value} ms (${formatMs(value)})`;
  if (def.unit === "percent") return `${value} %`;
  return String(value);
}

/**
 * One whitelisted setting: a switch for a flag, else a number input with the whitelist's
 * bounds; its help, the stored value and the default below, and the refusal when there is one.
 */
export function SettingField({
  setting,
  text,
  error,
  onChange,
}: {
  readonly setting: OperatorSettingView;
  /** The input's text; a flag's is "1" or "0". */
  readonly text: string;
  readonly error: string | undefined;
  readonly onChange: (text: string) => void;
}) {
  const def: OperatorSettingDef = OPERATOR_SETTINGS[setting.key];
  const hint = (
    <>
      {`${def.help} Now ${shown(def, setting.value)}; default ${shown(def, def.default)}. `}
      <span className="font-mono">{setting.key}</span>
    </>
  );
  const flag = def.unit === "flag";
  return (
    <div className="flex flex-col gap-1">
      <Field
        label={flag ? def.label : `${def.label}${UNIT_LABEL[def.unit]}`}
        hint={hint}
        error={error}
        announce
        layout={flag ? "inline" : "stacked"}
      >
        {({ id, labelId, describedBy, invalid }) =>
          flag ? (
            <Switch
              id={id}
              aria-labelledby={labelId}
              aria-describedby={describedBy}
              checked={text === "1"}
              onCheckedChange={(on: boolean) => onChange(on ? "1" : "0")}
            />
          ) : (
            <Input
              id={id}
              type="number"
              inputMode={def.int ? "numeric" : "decimal"}
              min={def.offAtZero === true ? 0 : def.min}
              max={def.max}
              step={def.int ? 1 : "any"}
              value={text}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onChange={(event) => onChange(event.target.value)}
              className="max-w-48"
            />
          )
        }
      </Field>
      {!setting.valid && (
        <p className="text-sm text-danger">
          The stored value is missing or out of range; saving writes a valid
          one.
        </p>
      )}
    </div>
  );
}
