import { expect, test } from "vitest";
import { sha256Hex } from "./hash/hashes.js";
import {
  MISSION_SECTIONS,
  MissionText,
  renderMission,
  sectionKey,
} from "./mission.js";

const TEXT: MissionText = {
  who_md: "A builder.",
  what_md: "One README line.",
  how_md: "Edit README.md.",
  laws_md: "Touch nothing else.",
};

test("renders the four sections under the agent's name, in order", () => {
  expect(renderMission("builder-1", TEXT)).toBe(
    "# Mission: builder-1\n\n" +
      "## Who\nA builder.\n\n" +
      "## What\nOne README line.\n\n" +
      "## How\nEdit README.md.\n\n" +
      "## Laws\nTouch nothing else.\n",
  );
});

test("CRLF and surrounding whitespace do not change the note or its hash", async () => {
  const messy: MissionText = {
    who_md: "  A builder.\r\n",
    what_md: "\nOne README line.",
    how_md: "Edit README.md.\r",
    laws_md: "Touch nothing else.\n\n",
  };
  expect(renderMission("b", messy)).toBe(renderMission("b", TEXT));
  expect(await sha256Hex(renderMission("b", messy))).toBe(
    await sha256Hex(renderMission("b", TEXT)),
  );
});

test("inner line breaks are kept; an empty section still renders its heading", () => {
  const note = renderMission("b", {
    ...TEXT,
    laws_md: "- one\r\n- two",
    how_md: "",
  });
  expect(note).toContain("## How\n\n\n## Laws\n- one\n- two\n");
});

test("any edit to any section, or the agent, changes the rendered note", () => {
  const base = renderMission("b", TEXT);
  for (const section of MISSION_SECTIONS) {
    const key = sectionKey(section);
    expect(
      renderMission("b", { ...TEXT, [key]: `${TEXT[key]}!` }),
      section,
    ).not.toBe(base);
  }
  expect(renderMission("c", TEXT)).not.toBe(base);
});

test("MissionText requires every section as a string", () => {
  expect(MissionText.safeParse(TEXT).success).toBe(true);
  expect(MissionText.safeParse({ ...TEXT, laws_md: undefined }).success).toBe(
    false,
  );
  expect(MissionText.safeParse({ ...TEXT, who_md: 1 }).success).toBe(false);
});
