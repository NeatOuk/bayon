import {
  MISSION_SECTIONS,
  sectionBody,
  sectionKey,
  type MissionText,
} from "@bayon/core";
import type { MissionDiff, MissionDiffChange } from "@bayon/proto";
import { diffLines } from "diff";

// `GET /missions/:agent/diff/:a/:b` (§12.3 "diff against any version"): each section compared as
// the template renders it, so edits the rendered note (and its hash) ignore are not changes.

type Version = MissionText & { readonly version: number };

/** A section's rendered lines, each ending in a newline, so the last line diffs like the rest. */
const lines = (md: string): string => {
  const body = sectionBody(md);
  return body === "" ? "" : `${body}\n`;
};

const op = (change: {
  readonly added: boolean;
  readonly removed: boolean;
}): MissionDiffChange["op"] => {
  if (change.added) return "add";
  return change.removed ? "remove" : "same";
};

/** Version `from` → `to` of an agent's mission, line by line, per section. */
export function diffMissions(
  agent: string,
  from: Version,
  to: Version,
): MissionDiff {
  return {
    agent,
    from: from.version,
    to: to.version,
    sections: MISSION_SECTIONS.map((section) => {
      const key = sectionKey(section);
      const changes = diffLines(lines(from[key]), lines(to[key])).map(
        (change) => ({ op: op(change), text: change.value }),
      );
      return {
        section,
        changed: changes.some((change) => change.op !== "same"),
        changes,
      };
    }),
  };
}
