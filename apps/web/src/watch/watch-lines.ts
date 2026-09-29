import type { EventItem } from "@bayon/proto";
import { formatBytes, isError } from "@/timeline/event-view";

// The Watch pane's terminal lines: one canonical event (§5.2) as the text an operator
// would have seen scroll past in the agent's own terminal. Pure, so every kind is testable without
// a terminal. Styling is ANSI SGR only — which colour each code is comes from the theme's tokens at
// runtime (lib/terminal-theme.ts), never from here.

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
/** ANSI red: the theme maps it to `--danger`. */
const ERROR = "\x1b[31m";
/** ANSI green: the theme maps it to `--success`. */
const MARK = "\x1b[32m";
/** ANSI bright black: the theme maps it to `--muted-foreground`. */
const MUTED = "\x1b[90m";

/** A one-line preview's cap, as the Timeline's (event-row.tsx). */
const PREVIEW_CHARS = 160;
/** How many lines of a result's head the pane shows; the rest is the Timeline's, or the file's. */
const HEAD_LINES = 12;

/**
 * Runner text with every control character but newline and tab removed: an agent's output is data,
 * and an escape sequence in it must never drive the operator's terminal (a cursor move, a title, a
 * clipboard write). Carriage returns go too, so a line can never overwrite the one before it.
 */
export const sanitize = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

const oneLine = (value: unknown): string => {
  const text = sanitize(
    typeof value === "string" ? value : (JSON.stringify(value) ?? ""),
  ).replace(/\s+/g, " ");
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}…`
    : text;
};

const styled = (style: string, text: string): string =>
  `${style}${text}${RESET}`;

const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 19);

/** An optional field after `prefix`. A string is runner text like any other (a model name, a stop
 * reason): stripped here, so no call site can forget to. */
const part = (value: string | number | undefined, prefix = " · ") =>
  value === undefined
    ? ""
    : `${prefix}${typeof value === "string" ? sanitize(value) : value}`;

const tokens = (usage: { tokens_in: number; tokens_out: number }) =>
  `${usage.tokens_in} in · ${usage.tokens_out} out`;

/** `lines` indented and muted, at most HEAD_LINES of them, saying how many more there were. */
function head(text: string): string[] {
  const lines = sanitize(text).replace(/\n+$/, "").split("\n");
  const shown = lines
    .slice(0, HEAD_LINES)
    .map((line) => styled(MUTED, `    ${line}`));
  const more = lines.length - HEAD_LINES;
  return more > 0
    ? [...shown, styled(MUTED, `    … ${more} more lines`)]
    : shown;
}

/** The event's own lines, before any truncation note. */
function body(event: EventItem): string[] {
  const failed = isError(event);
  switch (event.kind) {
    case "session_init":
      return [
        styled(
          MUTED,
          `· session ${sanitize(event.payload.runner_session_id)}${part(event.payload.model)}`,
        ),
      ];
    case "turn_start":
      return [styled(MARK, `── turn · ${clock(event.ts)} ──`)];
    case "turn_end":
      return [
        styled(
          MUTED,
          `── turn end${part(event.payload.stop_reason)}${part(
            event.payload.usage && tokens(event.payload.usage),
          )} ──`,
        ),
      ];
    case "assistant_text":
      return sanitize(event.text).split("\n");
    case "reasoning":
      return [styled(MUTED, `(thinking · ${event.text.length} chars)`)];
    case "tool_call":
      return [
        `${styled(BOLD, `▸ ${sanitize(event.tool_name)}`)} ${oneLine(event.payload.input)}`,
      ];
    case "tool_result": {
      const status = `  ↳ ${sanitize(event.tool_name ?? "result")} → ${event.status}${part(event.exit_code, " · exit ")}`;
      return [
        failed ? styled(ERROR, status) : status,
        ...(event.payload.head === undefined ? [] : head(event.payload.head)),
        ...(event.payload.output_path === undefined
          ? []
          : [styled(MUTED, `    → ${sanitize(event.payload.output_path)}`)]),
      ];
    }
    case "command": {
      const argv = `$ ${oneLine(event.payload.argv.join(" "))}`;
      const outcome = `${part(event.exit_code, " → exit ")}${part(
        event.payload.duration_ms === undefined
          ? undefined
          : `${(event.payload.duration_ms / 1000).toFixed(1)}s`,
      )}`;
      return [
        failed
          ? styled(ERROR, `${argv}${outcome}`)
          : `${styled(BOLD, argv)}${outcome}`,
        ...(event.payload.output_path === undefined
          ? []
          : [styled(MUTED, `    → ${sanitize(event.payload.output_path)}`)]),
      ];
    }
    case "file_change": {
      const change = { add: "A", modify: "M", delete: "D" }[
        event.payload.change
      ];
      const repo =
        event.payload.repo === undefined
          ? ""
          : `${sanitize(event.payload.repo)}:`;
      return [
        styled(
          MUTED,
          `  ${change} ${repo}${sanitize(event.payload.path)} +${event.payload.lines_added ?? 0} -${event.payload.lines_removed ?? 0}`,
        ),
      ];
    }
    case "todo": {
      const items = event.payload.items;
      const done = items.filter((i) => i.status === "completed").length;
      const now = items.find((i) => i.status === "in_progress");
      return [
        styled(
          MUTED,
          `  todo ${done}/${items.length}${part(now && oneLine(now.text), " · now: ")}`,
        ),
      ];
    }
    case "mcp_call":
      return [
        `${styled(BOLD, `▸ ${sanitize(event.payload.server)}.${sanitize(event.tool_name)}`)}${part(event.payload.args_digest && oneLine(event.payload.args_digest), " ")}`,
      ];
    case "approval_request":
      return [
        `? approve ${styled(BOLD, sanitize(event.tool_name))}${part(event.payload.risk && sanitize(event.payload.risk), " · risk ")} ${oneLine(event.payload.input)}`,
      ];
    case "usage":
      // Spend is the header's and the Spend screen's; a line per usage report is noise here.
      return [];
    case "error":
      return [
        styled(
          ERROR,
          `✖ ${sanitize(event.payload.class)}: ${oneLine(event.payload.message)}`,
        ),
      ];
    case "terminal": {
      const line = `■ run ${event.payload.outcome}${part(
        event.payload.error && oneLine(event.payload.error.message),
      )}${part(event.payload.cost_usd?.toFixed(2), " · $")}`;
      return [styled(failed ? ERROR : MARK, line)];
    }
    case "runner_native":
      return [styled(MUTED, `· ${sanitize(event.runner_type)}`)];
  }
}

/**
 * `event` as terminal text, each line ending in `\n` (the terminal converts line endings), or "" for
 * a kind the pane leaves to other screens. A capped event (§8.5, Invariant 9) says how big it was
 * and where the rest is, as the Timeline does — the pane never loads the full payload.
 */
export function watchLines(event: EventItem): string {
  const lines = [
    ...body(event),
    ...(event.truncated === true
      ? [
          styled(
            MUTED,
            `    … truncated${part(
              event.bytes_original === undefined
                ? undefined
                : formatBytes(event.bytes_original),
            )}${part(event.payload_path && sanitize(event.payload_path), " → ")}`,
          ),
        ]
      : []),
  ];
  return lines.map((line) => `${line}\n`).join("");
}
