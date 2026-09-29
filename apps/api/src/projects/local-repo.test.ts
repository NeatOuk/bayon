import { describe, expect, test } from "vitest";
import { allowCommand } from "./local-repo.js";

// The shell command a folder refusal hands over: pasted as it is into a terminal, so it
// must survive any character a path may hold. `frm roots add` appends, so it names the one folder.
describe("allowCommand", () => {
  test("names the one folder, normalised", () => {
    expect(allowCommand("/Users/me/ttm")).toBe(
      "pnpm frm roots add /Users/me/ttm --yes",
    );
    expect(allowCommand("/Users/me/it's/../ttm/")).toBe(
      "pnpm frm roots add /Users/me/ttm --yes",
    );
  });

  test("spaces, quotes and $ make one single-quoted word", () => {
    expect(allowCommand("/Users/me/my ttm")).toBe(
      "pnpm frm roots add '/Users/me/my ttm' --yes",
    );
    expect(allowCommand("/Users/me/it's $HOME")).toBe(
      "pnpm frm roots add '/Users/me/it'\\''s $HOME' --yes",
    );
  });
});
