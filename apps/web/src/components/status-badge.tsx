import { Badge } from "@/components/ui/badge";
import {
  TONE_TEXT,
  statusOf,
  type StatusEntity,
  type StatusEntry,
} from "@/components/status";
import { cn } from "@/lib/utils";

/** Either a state of an entity the map knows, or an entry a resolver already chose (gateStatus, …). */
type Source =
  | {
      readonly entity: StatusEntity;
      readonly state: string;
      readonly status?: never;
    }
  | {
      readonly status: StatusEntry;
      readonly entity?: never;
      readonly state?: never;
    };

const resolve = (source: Source): StatusEntry =>
  source.status ?? statusOf(source.entity, source.state);

/**
 * A state as a badge: its tone's soft surface, its icon (hidden from assistive tech: the label says
 * it) and its human label. `label` replaces the map's words where the badge says more (a test's
 * name, a rule's sentence); the tone and icon still come from the map.
 */
export function StatusBadge({
  label,
  className,
  ...source
}: Source & { readonly label?: string; readonly className?: string }) {
  const status = resolve(source);
  const Icon = status.icon;
  return (
    <Badge
      variant="outline"
      tone={status.tone}
      data-tone={status.tone}
      data-state={source.state}
      className={className}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      {label ?? status.label}
    </Badge>
  );
}

/** The state's icon alone in its tone, beside words that already name the state (a column heading). */
export function StatusIcon({
  className,
  ...source
}: Source & { readonly className?: string }) {
  const status = resolve(source);
  const Icon = status.icon;
  return (
    <Icon
      aria-hidden="true"
      data-tone={status.tone}
      className={cn("size-4 shrink-0", TONE_TEXT[status.tone], className)}
    />
  );
}
