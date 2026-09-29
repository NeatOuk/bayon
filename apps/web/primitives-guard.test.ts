import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// The shared primitives stay the only way, checked the way colours.test.ts checks the
// palette: by reading what ships. Each rule names the one place its pattern may live. Comments are
// blanked first (keeping line numbers), so prose that mentions an `<a>` is not a link.

const WEB = new URL("./", import.meta.url);

/** Shipped sources, as `src/…` paths: tests, their fixtures and helpers carry no UI. */
const sources = (): string[] =>
  readdirSync(new URL("src/", WEB), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".tsx") || path.endsWith(".ts"))
    .filter((path) => !/\.test\.tsx?$/.test(path) && !path.startsWith("test/"))
    .map((path) => `src/${path}`);

/** Block comments and whole-line `//` comments as spaces, newlines kept. */
const withoutComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^(\s*)\/\/.*$/gm, (_line, indent: string) => indent);

const code = (path: string): string =>
  withoutComments(readFileSync(new URL(path, WEB), "utf8"));

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split("\n").length;

interface Hit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Every match of `pattern` in the shipped sources `where` picks. */
function matches(
  pattern: RegExp,
  where: (path: string) => boolean = () => true,
): Hit[] {
  const global = new RegExp(pattern.source, `${pattern.flags}g`);
  return sources()
    .filter(where)
    .flatMap((path) => {
      const text = code(path);
      return [...text.matchAll(global)].map((match) => ({
        path,
        line: lineOf(text, match.index),
        text: match[0],
      }));
    });
}

const shown = (hits: readonly Hit[]): string[] =>
  hits.map(
    ({ path, line, text }) => `${path}:${line}: ${text.replace(/\s+/g, " ")}`,
  );

const outside =
  (...allowed: readonly string[]) =>
  (path: string): boolean =>
    !allowed.includes(path);

test("the guard reads the shipped sources, without their comments", () => {
  expect(sources()).toContain("src/components/text-link.tsx");
  expect(sources().some((path) => path.endsWith(".test.tsx"))).toBe(false);
  const blanked = withoutComments("a /* <a>\n */ b\n  // <a>\nc");
  expect(blanked.split("\n")).toHaveLength(4);
  expect(blanked).not.toContain("<a>");
});

// The patterns, named so the planted offenders below prove each one still catches what it polices.
const RAW_RADIO = /type=["']radio["']/;
/** An `<a …>` tag, across lines, to its first `>` that is not an arrow function's; `render={` kept. */
const A_TAG = /(render=\{\s*)?<a(?=[\s>/])(?:[^>]|=>)*>/;
const LINK_RECIPE =
  /buttonVariants\(|FOCUS_RING|textLinkClass\(|STRETCHED_LINK/;
const COPIED_RECIPE = /const (?:LINK|FOCUS)\s*=\s*["'`]/;
const BADGE_TERNARY = /<Badge\b[^>]*?variant=\{[^}]*\?/;
const BARE_ALERT = /<(p|span|div) role=(["'])alert\2>([\s\S]*?)<\/\1>/;
const BARE_LOADING = /<(?:p|span)\b[^>]*>\s*loading\b/i;
const LOCAL_FIELD = /(?:function Field\s*[(<]|(?:const|let) Field\s*[=:])/;
const THICK_BORDER = /\bborder-(?:[trblxy]-)?2\b/;
const RAW_H1 = /<h1\b/;
/** A screen's own centred frame: the width and the centring are PageContainer's. */
const LOCAL_FRAME = /\bmx-auto\b[^"`]*\bmax-w-|\bmax-w-\S+[^"`]*\bmx-auto\b/;

/** A link tag that brings its own recipe: none of the shared ones, and not a bare `render` target. */
const ownRecipe = (tag: string): boolean =>
  !(tag.startsWith("render=") && !/className=/.test(tag)) &&
  !LINK_RECIPE.test(tag);

/** An alert that holds an error's words: the old screen-level query error. */
const holdsError = (alert: string): boolean => /error|unavailable/i.test(alert);

test("each detector catches a planted offender, and passes its sanctioned form", () => {
  const first = (re: RegExp, text: string) => re.exec(text)?.[0] ?? "";
  expect(RAW_RADIO.test(`<input type='radio' />`)).toBe(true);
  expect(
    ownRecipe(first(A_TAG, `<a\n  href={x}\n  className="underline">`)),
  ).toBe(true);
  expect(
    ownRecipe(first(A_TAG, `<a href={x} onClick={() => go()} className="x">`)),
  ).toBe(true);
  expect(
    ownRecipe(first(A_TAG, `render={<a href={x} className="underline" />}`)),
  ).toBe(true);
  expect(
    ownRecipe(first(A_TAG, `render={<a href={x} target="_blank" />}`)),
  ).toBe(false);
  expect(
    ownRecipe(first(A_TAG, `<a href={x} className={cn("block", FOCUS_RING)}>`)),
  ).toBe(false);
  expect(A_TAG.test("<abbr title>")).toBe(false);
  expect(COPIED_RECIPE.test('const LINK =\n  "underline"')).toBe(true);
  expect(COPIED_RECIPE.test("const FOCUS = cn(FOCUS_RING, 'x')")).toBe(false);
  expect(
    BADGE_TERNARY.test('<Badge variant={ok ? "default" : "outline"}>'),
  ).toBe(true);
  expect(
    holdsError(first(BARE_ALERT, `<p role='alert'>{q.error.message}</p>`)),
  ).toBe(true);
  expect(
    holdsError(first(BARE_ALERT, `<span role="alert"><StatusBadge /></span>`)),
  ).toBe(false);
  expect(
    BARE_LOADING.test(`<p className="text-sm">loading the board…</p>`),
  ).toBe(true);
  expect(LOCAL_FIELD.test("const Field = (props: P) =>")).toBe(true);
  expect(LOCAL_FIELD.test("function Field<T>({")).toBe(true);
  expect(LOCAL_FIELD.test("function FieldRow(")).toBe(false);
  expect(THICK_BORDER.test("border-t-2 pt-2")).toBe(true);
  expect(THICK_BORDER.test("border-2")).toBe(true);
  expect(THICK_BORDER.test("border-t pt-2")).toBe(false);
  expect(LOCAL_FRAME.test('className="mx-auto flex max-w-5xl p-6"')).toBe(true);
  expect(LOCAL_FRAME.test('className="max-w-6xl mx-auto"')).toBe(true);
  expect(LOCAL_FRAME.test('className="max-w-3xl text-sm"')).toBe(false);
});

test("no raw radio input: RadioChoices / RadioGroup over base-ui", () => {
  expect(shown(matches(RAW_RADIO))).toEqual([]);
});

test("no raw link with its own recipe: TextLink, or a shared recipe for a link laid out as a row, a card or a button", () => {
  const tags = matches(
    A_TAG,
    (path) =>
      path.endsWith(".tsx") && outside("src/components/text-link.tsx")(path),
  ).filter(({ text }) => ownRecipe(text));
  expect(shown(tags)).toEqual([]);
});

test("no hand-copied link or focus recipe constant: the recipes live in text-link.tsx", () => {
  // A constant composed from FOCUS_RING (an offset for a scroller that would clip it) is not a copy.
  expect(
    shown(matches(COPIED_RECIPE, outside("src/components/text-link.tsx"))),
  ).toEqual([]);
});

test("no Badge variant chosen by an inline ternary: states read through status.ts", () => {
  expect(
    shown(matches(BADGE_TERNARY, outside("src/components/status-badge.tsx"))),
  ).toEqual([]);
});

test("no failed query as a bare alert paragraph: QueryError says it, with Retry", () => {
  // The old screen-level error: an unstyled alert holding an error's message. A form's own inline
  // error carries its class; an alert around a StatusBadge announces a state, not an error.
  const bare = matches(
    BARE_ALERT,
    outside("src/components/query-error.tsx"),
  ).filter(({ text }) => holdsError(text));
  expect(shown(bare)).toEqual([]);
});

test("no bare loading sentence: Loading says it", () => {
  expect(shown(matches(BARE_LOADING))).toEqual([]);
});

test("one Field: no local copy of the labelled-field helper", () => {
  expect(
    shown(matches(LOCAL_FIELD, outside("src/components/field.tsx"))),
  ).toEqual([]);
});

test("no thick border leftovers: hairlines are one pixel", () => {
  expect(shown(matches(THICK_BORDER))).toEqual([]);
});

test("every screen's h1 is a PageHeader (a login card's title is CardTitle as h1)", () => {
  expect(
    shown(matches(RAW_H1, outside("src/components/page-header.tsx"))),
  ).toEqual([]);
});

test("no screen frames itself: the page's width, centring and padding are PageContainer's", () => {
  expect(
    shown(matches(LOCAL_FRAME, outside("src/components/page-container.tsx"))),
  ).toEqual([]);
});
