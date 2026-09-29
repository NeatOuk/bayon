// PreToolUse guard (CLAUDE.md): a migration already on origin/main is never edited — add a new file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import process from "node:process";

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? "";
if (!/\/packages\/db\/migrations\/[^/]+$/.test(file)) process.exit(0);

try {
  const top = execFileSync(
    "git",
    ["-C", dirname(file), "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  ).trim();
  execFileSync(
    "git",
    ["-C", top, "cat-file", "-e", `origin/main:${relative(top, file)}`],
    { stdio: "ignore" },
  );
} catch {
  process.exit(0); // not on main yet: a new migration, allowed
}
process.stderr.write(
  `${file} is already on main. Migrations are forward-only: add a new numbered file.\n`,
);
process.exit(2);
