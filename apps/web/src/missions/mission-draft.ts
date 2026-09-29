import { sectionKey, type MissionSection, type MissionText } from "@bayon/core";
import type { MissionSaveRequest, MissionVersion } from "@bayon/proto";

// The editor's pure half: what a draft starts from, and when it may be saved (§12.3).

/** One section editor: the label an operator reads, and what belongs in it. */
export interface SectionField {
  readonly section: MissionSection;
  readonly label: string;
  readonly hint: string;
}

export const SECTION_FIELDS: readonly SectionField[] = [
  {
    section: "who",
    label: "Who",
    hint: "Identity, role and who it answers to.",
  },
  {
    section: "what",
    label: "What",
    hint: "Scope, and the actions it takes every pulse.",
  },
  { section: "how", label: "How", hint: "Working method and conventions." },
  {
    section: "laws",
    label: "Laws",
    hint: "Hard rules, one per line. Add one the moment an agent misbehaves.",
  },
];

const EMPTY: MissionText = { who_md: "", what_md: "", how_md: "", laws_md: "" };

/** The four sections of a version, or empty ones before the first save. */
export const textOf = (version: MissionVersion | null): MissionText =>
  version === null
    ? EMPTY
    : {
        who_md: version.who_md,
        what_md: version.what_md,
        how_md: version.how_md,
        laws_md: version.laws_md,
      };

/** The version a save builds on: 0 before the first. */
export const versionOf = (version: MissionVersion | null): number =>
  version?.version ?? 0;

export const withSection = (
  text: MissionText,
  section: MissionSection,
  md: string,
): MissionText => ({ ...text, [sectionKey(section)]: md });

/** The request a save sends, or null while the changelog line is blank: a new version needs one. */
export function saveRequest(
  text: MissionText,
  note: string,
  baseVersion: number,
): MissionSaveRequest | null {
  const line = note.trim();
  return line === ""
    ? null
    : { ...text, note: line, base_version: baseVersion };
}
