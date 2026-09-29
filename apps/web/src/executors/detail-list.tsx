import { DescriptionList } from "@/components/description-list";
import { SectionTitle } from "@/components/page-header";
import { Muted } from "@/tickets/ticket-sections";

// An executor's JSON columns (health_detail, config) as a definition list. Their shape belongs to
// each executor kind, so nothing here names a key: nested objects flatten to dotted keys, lists
// join, null reads as a dash.

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const item = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? JSON.stringify(value)
    : String(value);

function text(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value))
    return value.length === 0 ? "none" : value.map(item).join("; ");
  return item(value);
}

/** Every leaf of `value` as [dotted key, text], in the object's own order. */
export function detailEntries(
  value: unknown,
  prefix = "",
): readonly (readonly [string, string])[] {
  if (!isRecord(value))
    return [[prefix === "" ? "value" : prefix.slice(0, -1), text(value)]];
  return Object.entries(value).flatMap(([key, child]) =>
    isRecord(child)
      ? detailEntries(child, `${prefix}${key}.`)
      : [[`${prefix}${key}`, text(child)] as const],
  );
}

export function DetailList({
  title,
  value,
  empty,
}: {
  readonly title: string;
  readonly value: unknown;
  readonly empty: string;
}) {
  const entries = value === null ? [] : detailEntries(value);
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle as="h3">{title}</SectionTitle>
      {entries.length === 0 ? (
        <Muted>{empty}</Muted>
      ) : (
        <DescriptionList aria-label={title} mono items={entries} />
      )}
    </div>
  );
}
