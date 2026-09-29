import { z } from "zod";

// A mission note (§4 `missions`, §12.3): four operator-written sections, rendered by one template
// into the text agents receive. `missions.hash` is sha256Hex of that rendering, so it is
// reproducible from the stored sections alone.

export const MISSION_SECTIONS = ["who", "what", "how", "laws"] as const;
export const MissionSection = z.enum(MISSION_SECTIONS);
export type MissionSection = z.infer<typeof MissionSection>;

/** The editable text of one version: a `missions` row's four `*_md` columns. */
export const MissionText = z.object({
  who_md: z.string(),
  what_md: z.string(),
  how_md: z.string(),
  laws_md: z.string(),
});
export type MissionText = z.infer<typeof MissionText>;

/** The `missions` column holding a section. */
export const sectionKey = (section: MissionSection) => `${section}_md` as const;

const HEADINGS: Readonly<Record<MissionSection, string>> = {
  who: "Who",
  what: "What",
  how: "How",
  laws: "Laws",
};

/** A section as the template renders it: LF line endings, no surrounding whitespace. */
export const sectionBody = (md: string): string =>
  md.replace(/\r\n?/g, "\n").trim();

/**
 * The mission template: `# Mission: <agent>`, then `## Who`, `## What`, `## How`, `## Laws`, each
 * followed by its `sectionBody`, ending in one newline. Same agent and text, same bytes.
 */
export function renderMission(agentName: string, text: MissionText): string {
  const sections = MISSION_SECTIONS.map(
    (section) =>
      `## ${HEADINGS[section]}\n${sectionBody(text[sectionKey(section)])}`,
  );
  return `# Mission: ${agentName}\n\n${sections.join("\n\n")}\n`;
}
