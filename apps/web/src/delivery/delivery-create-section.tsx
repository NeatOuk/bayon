import type { DeliveryConfigView } from "@bayon/proto";
import { NO_DELIVERY } from "@bayon/proto";
import { SectionTitle } from "@/components/page-header";
import { DeliveryFields, DELIVERY_SECTION_LABEL } from "./delivery-fields";

// New project's optional Delivery section. Off by default, and deliberately so: a
// project that has not asked for it gets no network write from Bayon at all (§14). Everything here
// can be set later in the project's Settings; it is on the form so an operator who already knows
// where the work should go need not go looking for it afterwards.

export const DELIVERY_CREATE_LABEL = "Deliver finished work";

/** What the section reads as when it is switched on but nothing has been chosen. */
export const BLANK_DELIVERY: DeliveryConfigView = {
  ...NO_DELIVERY,
  mode: "pull_request",
};

export function DeliveryCreateSection({
  draft,
  onChange,
}: {
  readonly draft: DeliveryConfigView;
  readonly onChange: (draft: DeliveryConfigView) => void;
}) {
  return (
    <div
      role="group"
      aria-label={DELIVERY_CREATE_LABEL}
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <SectionTitle as="h2" className="text-sm">
        {DELIVERY_CREATE_LABEL}
      </SectionTitle>
      <p className="text-xs text-muted-foreground">
        {`${DELIVERY_SECTION_LABEL} is off until you choose otherwise, here or later in the project's Settings.`}
      </p>
      <DeliveryFields draft={draft} onChange={onChange} />
    </div>
  );
}
