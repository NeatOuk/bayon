import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

// Every user-facing message reads in plain words (the design): no spec citation and
// no ticket key in any string the GUI shows or `frm` prints. Comments keep theirs — they are the
// spec's cross-references for developers, and the compiler never hands them to this walk.
const root = new URL("./", import.meta.url);
// `testing/` holds test worlds and stand-ins (a fake forge's git, a fake docker): never shipped to
// an operator, and often a program in a string whose comments are the program's.
const SKIP = new Set(["node_modules", "dist", "coverage", "testing"]);

/** Where text reaching the GUI or the terminal is written. */
const SCANNED = [
  "apps/api/src/",
  "apps/web/src/",
  "apps/supervisor/src/",
  "tools/frm/src/",
  "packages/core/src/",
  "packages/proto/src/",
  "packages/db/src/",
  "packages/executors/src/",
  "packages/runners/src/",
];

/** Files not scanned, each with its reason. */
const NOT_SCANNED: Readonly<Record<string, string>> = {
  // A program in a string: its `//` lines are the program's comments.
  "packages/runners/src/adapters/codex-exec/host.ts": "embedded host script",
  "packages/executors/src/container/fake-docker.ts": "embedded test shell",
  // Bytes that are hashed into an identity: rewording them would rebuild every executor image, or
  // decertify every opencode pair. Neither is an error message.
  "packages/executors/src/container/image.ts": "the rendered Dockerfile",
  "packages/runners/src/adapters/opencode/registration.ts":
    "hashed into the kit",
};

/** A spec citation, or a ticket key (the old `FOR-n` label included). */
const JARGON = /§|\b(?:BAYON|FOR)-\d+\b/;

const isSource = (name: string) =>
  /\.tsx?$/.test(name) &&
  !/\.test\.tsx?$/.test(name) &&
  !name.endsWith(".d.ts");

function filesUnder(rel: string): string[] {
  return readdirSync(new URL(rel, root), { withFileTypes: true }).flatMap(
    (entry) => {
      if (SKIP.has(entry.name)) return [];
      const path = `${rel}${entry.name}`;
      if (entry.isDirectory()) return filesUnder(`${path}/`);
      return isSource(entry.name) ? [path] : [];
    },
  );
}

/** Each string literal, template part and JSX text of `rel` that matches JARGON. */
function jargonIn(rel: string, text: string): string[] {
  const source = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    false,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    const literal =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (literal && JARGON.test(node.text)) {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      hits.push(`${rel}:${line + 1}: ${node.text.replace(/\s+/g, " ").trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

// Parses every scanned file: seconds alone, longer when the whole suite shares the CPU.
test("no user-facing string cites the spec or a ticket", () => {
  const hits = SCANNED.flatMap(filesUnder)
    .filter((rel) => NOT_SCANNED[rel] === undefined)
    .flatMap((rel) => jargonIn(rel, readFileSync(new URL(rel, root), "utf8")));
  expect(hits).toEqual([]);
}, 60_000);

test("every file left out of the scan still exists", () => {
  const gone = Object.keys(NOT_SCANNED).filter(
    (rel) => !existsSync(new URL(rel, root)),
  );
  expect(gone).toEqual([]);
});

test("the walk sees strings, templates and JSX text, never comments", () => {
  const sample = [
    "// §14 in a comment",
    "/* FOR-1 */",
    'const a = "see §9.5";',
    "const b = `x ${a} (FOR-12) y`;",
    "const c = <p>takeover (§12.5)</p>;",
    'const d = "plain words";',
  ].join("\n");
  expect(jargonIn("sample.tsx", sample)).toEqual([
    "sample.tsx:3: see §9.5",
    "sample.tsx:4: (FOR-12) y",
    "sample.tsx:5: takeover (§12.5)",
  ]);
});
