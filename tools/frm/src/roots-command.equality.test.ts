import { allowCommand } from "@bayon/api/src/projects/local-repo.js";
import { describe, expect, test } from "vitest";
import { COMMANDS } from "./cli.js";
import { parseRootsCli } from "./roots.js";

// The command a refused folder hands the operator (the API's allowCommand) is one this
// CLI really takes: its verb is in COMMANDS, and `frm roots` parses the rest as an add of that very
// folder with --yes. A renamed verb or flag here fails this, not the operator's paste.

/** `pnpm frm <argv…>` split into argv; the paths here need no shell quoting. */
function argvOf(command: string): string[] {
  const prefix = "pnpm frm ";
  expect(command.startsWith(prefix)).toBe(true);
  return command.slice(prefix.length).split(" ");
}

describe("allowCommand matches the frm CLI", () => {
  test.each(["/Users/me/ttm", "/srv/projects/app"])(
    "%s: a known verb, parsed as roots add of that folder with --yes",
    (path) => {
      const argv = argvOf(allowCommand(path));
      expect(Object.keys(COMMANDS)).toContain(argv[0]);
      expect(parseRootsCli(argv)).toEqual({
        ok: true,
        value: { action: "add", path, yes: true },
      });
    },
  );
});
