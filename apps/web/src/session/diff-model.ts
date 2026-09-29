// How each line of a unified diff reads in the Diff tab: a file's header lines, a hunk header, an
// added, deleted or context line. Past a hunk header, `+++`/`---` are content, not headers. The
// +/- prefix stays in the text, so colour is never the only cue.

export type LineTone = "meta" | "hunk" | "add" | "del" | "context";

export interface PatchLine {
  readonly text: string;
  readonly tone: LineTone;
}

function toneIn(line: string, inHunk: boolean): LineTone {
  if (line.startsWith("@@")) return "hunk";
  if (!inHunk) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("\\")) return "meta";
  return "context";
}

/** The patch's lines with their tones; a trailing newline adds no empty last line. */
export function patchLines(patch: string): readonly PatchLine[] {
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;
  if (body === "") return [];
  return body
    .split("\n")
    .reduce<{ readonly inHunk: boolean; readonly lines: readonly PatchLine[] }>(
      ({ inHunk, lines }, text) => {
        const hunk = text.startsWith("diff --git ")
          ? false
          : inHunk || text.startsWith("@@");
        return {
          inHunk: hunk,
          lines: [...lines, { text, tone: toneIn(text, hunk) }],
        };
      },
      { inHunk: false, lines: [] },
    ).lines;
}

/** A sha as the Diff tab shows it. */
export const shortSha = (sha: string | null): string =>
  sha === null ? "?" : sha.slice(0, 7);
