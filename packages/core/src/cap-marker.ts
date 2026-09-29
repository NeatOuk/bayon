// The one line that says a tool result was cut and where the whole of it went (§8.5). Ingest's cap
// writes it into an event's projection; the API's MCP backstop writes it into a tool result, and
// ingest parses it back, so a result capped upstream still records truncated, bytes_original and
// payload_path. It is our own text, never a runner's, so it is runner-neutral (Invariant 1).

export interface TruncationFacts {
  readonly lines: number;
  readonly bytes: number;
  readonly path: string;
}

// Up to 15 digits: every such count is a safe integer.
const MARKER =
  /^… truncated: (\d{1,15}) lines, (\d{1,15}) bytes; full output in (.+) …$/;

export const truncationMarker = (f: TruncationFacts): string =>
  `… truncated: ${f.lines} lines, ${f.bytes} bytes; full output in ${f.path} …`;

/** The facts of the only whole-line marker in `text`; none, or more than one, is undefined. */
export function parseTruncationMarker(
  text: string,
): TruncationFacts | undefined {
  const found = text.split("\n").flatMap((line) => {
    const match = MARKER.exec(line);
    return match === null ? [] : [match];
  });
  const [only, ...more] = found;
  if (only === undefined || more.length > 0) return undefined;
  const [, lines, bytes, path] = only;
  if (lines === undefined || bytes === undefined || path === undefined) {
    return undefined;
  }
  return { lines: Number(lines), bytes: Number(bytes), path };
}
