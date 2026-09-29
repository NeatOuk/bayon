import { describe, expect, test } from "vitest";
import { DocsSource, DocsSpaceKey } from "./docs.js";
import { PatchProjectRequest } from "./projects.js";

// A space key on the wire: Confluence Cloud keys can be mixed case, so `Docs` is one; a shape that
// is not a key is still refused before anything is stored.

describe("DocsSpaceKey", () => {
  test("mixed-case keys pass unchanged; the case is kept", () => {
    for (const key of ["Docs", "DOCS", "docs", "Team_2"]) {
      expect(DocsSpaceKey.parse(key)).toBe(key);
    }
  });

  test("what is not a key is refused, and the message says letters of either case", () => {
    for (const bad of ["", "A-1", "A B", "~acct", "A".repeat(51)]) {
      expect(DocsSpaceKey.safeParse(bad).success, bad).toBe(false);
    }
    const refused = DocsSpaceKey.safeParse("A-1");
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues[0]?.message).toBe(
        "a space key: letters, digits and _",
      );
    }
  });
});

test("PATCH /projects/:id takes a mixed-case space list", () => {
  const docs = { kind: "confluence", spaces: ["Docs"] };
  expect(DocsSource.parse(docs).spaces).toEqual(["Docs"]);
  expect(PatchProjectRequest.safeParse({ docs }).success).toBe(true);
});
