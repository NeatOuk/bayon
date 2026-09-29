import { expect, test } from "vitest";
import { diffMissions } from "./mission-diff.js";

const TEXT = {
  who_md: "who",
  what_md: "what",
  how_md: "how",
  laws_md: "a\nb\nc",
};
const v = (version: number, over: Partial<typeof TEXT> = {}) => ({
  version,
  ...TEXT,
  ...over,
});

test("identical text: every section unchanged, in template order", () => {
  const diff = diffMissions("b", v(1), v(2));
  expect(diff).toMatchObject({ agent: "b", from: 1, to: 2 });
  expect(diff.sections.map((s) => [s.section, s.changed])).toEqual([
    ["who", false],
    ["what", false],
    ["how", false],
    ["laws", false],
  ]);
  expect(diff.sections[3]?.changes).toEqual([
    { op: "same", text: "a\nb\nc\n" },
  ]);
});

test("a changed line is removed then added; the lines around it are kept", () => {
  const laws = diffMissions("b", v(1), v(2, { laws_md: "a\nB\nc" }))
    .sections[3];
  expect(laws).toEqual({
    section: "laws",
    changed: true,
    changes: [
      { op: "same", text: "a\n" },
      { op: "remove", text: "b\n" },
      { op: "add", text: "B\n" },
      { op: "same", text: "c\n" },
    ],
  });
});

test("whitespace and line endings the template drops are not changes", () => {
  const diff = diffMissions(
    "b",
    v(1),
    v(2, { who_md: "  who\r\n", laws_md: "a\r\nb\r\nc\n" }),
  );
  expect(diff.sections.filter((s) => s.changed)).toEqual([]);
});

test("an emptied section is all removal, a filled one all addition", () => {
  const diff = diffMissions("b", v(1, { how_md: "" }), v(2, { what_md: "" }));
  expect(diff.sections[1]).toEqual({
    section: "what",
    changed: true,
    changes: [{ op: "remove", text: "what\n" }],
  });
  expect(diff.sections[2]).toEqual({
    section: "how",
    changed: true,
    changes: [{ op: "add", text: "how\n" }],
  });
  expect(
    diffMissions("b", v(1, { how_md: "" }), v(2, { how_md: " " })).sections[2],
  ).toEqual({ section: "how", changed: false, changes: [] });
});
