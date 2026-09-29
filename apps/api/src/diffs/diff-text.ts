import { SESSION_DIFF_CAP, type DiffFile } from "@bayon/proto";
import { headBytes } from "../mcp/cap.js";

// The pure half of GET /sessions/:id/diff: the file list read off a unified diff's own headers (the
// same for a worktree's `git diff` and a gate's diff.patch), and §8.5's cap applied head-first,
// since a patch reads top-down.

const HEADER = "diff --git ";

/** The b-side path of a `diff --git a/x b/y` header; quoted paths keep git's escapes as written. */
function headerPath(line: string): string {
  const rest = line.slice(HEADER.length);
  const quoted = rest.lastIndexOf(' "b/');
  if (quoted !== -1) return rest.slice(quoted + 4).replace(/"$/, "");
  const plain = rest.lastIndexOf(" b/");
  return plain === -1 ? rest : rest.slice(plain + 3);
}

interface Tally {
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
  /** Past the first `@@`: `+`/`-` lines count from here, `+++`/`---` headers are behind. */
  readonly inHunk: boolean;
}

function step(file: Tally, line: string): Tally {
  if (line.startsWith("@@")) return { ...file, inHunk: true };
  if (!file.inHunk)
    return line.startsWith("Binary files ") || line === "GIT binary patch"
      ? { ...file, binary: true }
      : file;
  if (line.startsWith("+")) return { ...file, added: file.added + 1 };
  if (line.startsWith("-")) return { ...file, deleted: file.deleted + 1 };
  return file;
}

/** Every file a unified diff touches, in order, with its added and deleted line counts. */
export function diffFiles(patch: string): DiffFile[] {
  const tallies = patch.split("\n").reduce<Tally[]>((files, line) => {
    if (line.startsWith(HEADER))
      return [
        ...files,
        {
          path: headerPath(line),
          added: 0,
          deleted: 0,
          binary: false,
          inHunk: false,
        },
      ];
    const last = files.at(-1);
    return last === undefined
      ? files
      : [...files.slice(0, -1), step(last, line)];
  }, []);
  return tallies.map(({ path, added, deleted, binary }) => ({
    path,
    added: binary ? null : added,
    deleted: binary ? null : deleted,
  }));
}

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly lines: number;
}

/** A trailing newline ends the last line; it does not start another. */
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * `text` whole when within `cap`; otherwise its first `cap.lines` lines, cut to `cap.bytes` on a
 * line boundary (or mid-line, never mid-character, when the first line alone is over it).
 */
export function capPatch(
  text: string,
  cap: { readonly bytes: number; readonly lines: number } = SESSION_DIFF_CAP,
): CappedText {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = lineCount(text);
  if (bytes <= cap.bytes && lines <= cap.lines)
    return { text, truncated: false, bytes, lines };
  const head = text.split("\n").slice(0, cap.lines).join("\n");
  const cut = headBytes(head, cap.bytes);
  const lastBreak = cut.lastIndexOf("\n");
  const whole =
    cut.length < head.length && lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
  return { text: whole, truncated: true, bytes, lines };
}
