import type { EventItem } from "@bayon/proto";

/** The Timeline filters of §12.3. */
export const CATEGORIES = ["tools", "text", "errors", "files"] as const;
export type Category = (typeof CATEGORIES)[number];

export const isCategory = (value: unknown): value is Category =>
  CATEGORIES.some((category) => category === value);

type Kind = EventItem["kind"];

const TOOL_KINDS: ReadonlySet<Kind> = new Set([
  "tool_call",
  "tool_result",
  "command",
  "mcp_call",
  "approval_request",
]);
const TEXT_KINDS: ReadonlySet<Kind> = new Set(["assistant_text", "reasoning"]);

/** Errors are highlighted: error events, failed tool results and commands, runs that did not end ok. */
export function isError(event: EventItem): boolean {
  switch (event.kind) {
    case "error":
      return true;
    case "tool_result":
      return event.status === "error" || (event.exit_code ?? 0) !== 0;
    case "command":
      return (event.exit_code ?? 0) !== 0;
    case "terminal":
      return event.payload.outcome !== "ok";
    default:
      return false;
  }
}

const IN_CATEGORY: Readonly<Record<Category, (event: EventItem) => boolean>> = {
  tools: (event) => TOOL_KINDS.has(event.kind),
  text: (event) => TEXT_KINDS.has(event.kind),
  errors: isError,
  files: (event) => event.kind === "file_change",
};

export const categoriesOf = (event: EventItem): ReadonlySet<Category> =>
  new Set(CATEGORIES.filter((category) => IN_CATEGORY[category](event)));

/** The events in any of the `active` categories; all of them when none is active. */
export function filterEvents(
  items: readonly EventItem[],
  active: ReadonlySet<Category>,
): readonly EventItem[] {
  if (active.size === 0) return items;
  const tests = [...active].map((category) => IN_CATEGORY[category]);
  return items.filter((event) => tests.some((test) => test(event)));
}

/** Index of the last error in `items`, or -1. */
export const lastErrorIndex = (items: readonly EventItem[]): number =>
  items.findLastIndex(isError);

const KIB = 1024;
const MIB = KIB * KIB;

export const formatBytes = (bytes: number): string =>
  bytes < KIB
    ? `${bytes} B`
    : bytes < MIB
      ? `${(bytes / KIB).toFixed(1)} KB`
      : `${(bytes / MIB).toFixed(1)} MB`;
