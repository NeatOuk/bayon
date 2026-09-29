import { Radio } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "@/lib/utils";

// shadcn's RadioGroup over base-ui's: the group owns the value and the arrow keys, each
// item is a native button named by a sibling `label[for]`. The unchecked ring is the 3:1
// input-border, the checked one and its dot the primary (colours.test.ts's control pairs).
function RadioGroup<Value>({
  className,
  ...props
}: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({ className, ...props }: Radio.Root.Props) {
  return (
    <Radio.Root
      data-slot="radio-group-item"
      nativeButton
      render={<button type="button" />}
      className={cn(
        "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-input-border bg-input shadow-xs transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring aria-invalid:border-danger data-checked:border-primary data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Radio.Indicator
        data-slot="radio-group-indicator"
        className="size-2 rounded-full bg-primary data-unchecked:hidden"
      />
    </Radio.Root>
  );
}

export { RadioGroup, RadioGroupItem };
