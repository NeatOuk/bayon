import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  blocks,
  contrast,
  parseColour,
  themeTokens,
  tokenColour,
  type ThemeName,
} from "./theme-contrast.js";

// The palette is defined once in src/theme.css: primitives per theme, then semantic tokens. Everything
// else names a semantic token (bg-primary, text-danger, …), never a colour.
const WEB = new URL("./", import.meta.url);
const THEME = "src/theme.css";

// The CSS named colours, plus `transparent`: a literal is still a literal spelled as a word
//. Deliberately not here: `Canvas`, `CanvasText`, `AccentColor`,
// `AccentColorText` and the other CSS *system* keywords — the platform resolves each from the
// running colour scheme, so naming one is naming a token, not picking a colour.
const NAMED_COLOURS = [
  "transparent",
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
].join("|");

const LITERALS = [
  /#[0-9a-f]{3,8}\b/i,
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i,
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret|divide|placeholder)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)\b/,
  // A named colour as a value: a string that is one ("gray"), or a CSS declaration set to one.
  new RegExp(`(["'\`])(?:${NAMED_COLOURS})\\1`, "i"),
  new RegExp(`:\\s*(?:${NAMED_COLOURS})\\s*(?:;|\\)|!important)`, "i"),
];

const read = (path: string) => readFileSync(new URL(path, WEB), "utf8");

// What ships: tests and their fixtures carry data ("#812" is a ticket), not styling.
const sources = (): string[] => [
  "index.html",
  ...readdirSync(new URL("src/", WEB), { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(tsx?|css)$/.test(path))
    .filter((path) => !/\.test\.tsx?$/.test(path) && !path.startsWith("test/"))
    .map((path) => `src/${path}`),
];

test("no colour literal outside the theme file", () => {
  const offenders = sources()
    .filter((path) => path !== THEME)
    .flatMap((path) =>
      read(path)
        .split("\n")
        .flatMap((line, i) =>
          LITERALS.some((re) => re.test(line))
            ? [`${path}:${i + 1}: ${line.trim()}`]
            : [],
        ),
    );
  expect(offenders).toEqual([]);
});

test("the theme fills every primitive once for light and once for dark, and maps them once", () => {
  const css = read(THEME);
  const found = blocks(css);
  const names = (selector: string): string[] =>
    Object.keys(found.get(selector) ?? {}).sort();
  const light = names(":root");
  expect(light.length).toBeGreaterThan(10);
  // Only the radius is the same in both themes, so only :root holds it.
  expect(names(".dark")).toEqual(light.filter((t) => t !== "radius"));
  // Semantic tokens are one mapping, from primitives only: never a colour of their own.
  const semantic = found.get(":root, .dark") ?? {};
  expect(Object.keys(semantic).length).toBeGreaterThan(30);
  const literal = Object.entries(semantic).filter(([, value]) =>
    /#[0-9a-f]{3,8}\b|\brgba?\(/i.test(value),
  );
  expect(literal).toEqual([]);
});

test("every --color-* the utilities read is a token the theme defines", () => {
  const css = read(THEME);
  const registered = [
    ...css.matchAll(/--color-[\w-]+:\s*var\(--([\w-]+)\)/g),
  ].map((m) => m[1] ?? "");
  for (const theme of ["light", "dark"] as const) {
    const tokens = themeTokens(css, theme);
    expect(registered.filter((name) => tokens[name] === undefined)).toEqual([]);
  }
});

// WCAG AA: body text 4.5:1; the edge that identifies a control, and the focus ring, 3:1.
const TONES = ["success", "warning", "info", "danger"] as const;
const TEXT_PAIRS: readonly (readonly [text: string, ground: string])[] = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "popover"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "accent"],
  ["muted-foreground", "selected"],
  ["accent-foreground", "accent"],
  ["secondary-foreground", "secondary"],
  ["secondary-foreground", "secondary-hover"],
  ["selected-foreground", "selected"],
  ["primary-foreground", "primary"],
  ["primary-foreground", "primary-hover"],
  ["primary", "card"],
  ["primary", "background"],
  ["destructive-foreground", "destructive"],
  ...TONES.flatMap((tone) => [
    [`${tone}-foreground`, tone] as const,
    [tone, "card"] as const,
    [tone, "background"] as const,
    [tone, `${tone}-subtle`] as const,
    ["foreground", `${tone}-subtle`] as const,
  ]),
];
const EDGE_PAIRS: readonly (readonly [edge: string, ground: string])[] = [
  ["input-border", "card"],
  ["input-border", "background"],
  ["input-border", "input"],
  ["ring", "card"],
  ["ring", "background"],
  ["ring", "popover"],
];

// Switch and checkbox states (non-text, 3:1): the unchecked edge against every surface a control
// sits on and against its own fill, the off thumb on its track, and the checked track or box against
// those surfaces with its thumb or tick on it.
const SURFACES = ["background", "card", "popover", "muted"] as const;
const CONTROL_PAIRS: readonly (readonly [part: string, ground: string])[] = [
  ...SURFACES.map((surface) => ["input-border", surface] as const),
  ["input-border", "input"],
  ["muted-foreground", "muted"],
  ...SURFACES.map((surface) => ["primary", surface] as const),
  ["primary-foreground", "primary"],
];

const shortfalls = (
  theme: ThemeName,
  pairs: readonly (readonly [string, string])[],
  minimum: number,
): string[] => {
  const tokens = themeTokens(read(THEME), theme);
  return pairs.flatMap(([fg, bg]) => {
    const ratio = contrast(tokenColour(tokens, fg), tokenColour(tokens, bg));
    return ratio >= minimum ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)}:1`];
  });
};

describe.each(["light", "dark"] as const)("the %s theme", (theme) => {
  test("text pairs reach 4.5:1", () => {
    expect(shortfalls(theme, TEXT_PAIRS, 4.5)).toEqual([]);
  });

  test("control edges and the focus ring reach 3:1", () => {
    expect(shortfalls(theme, EDGE_PAIRS, 3)).toEqual([]);
  });

  test("switches and checkboxes read on and off: every part 3:1 against what it sits on", () => {
    expect(shortfalls(theme, CONTROL_PAIRS, 3)).toEqual([]);
  });

  test("the overlay dims: a translucent dark scrim", () => {
    const overlay = tokenColour(themeTokens(read(THEME), theme), "overlay");
    expect(overlay.a).toBeGreaterThanOrEqual(0.4);
    expect(Math.max(overlay.r, overlay.g, overlay.b)).toBeLessThan(40);
  });

  test("popovers sit on their own raised surface, one step above a card in dark", () => {
    const tokens = themeTokens(read(THEME), theme);
    const card = tokenColour(tokens, "card");
    const raised = tokenColour(tokens, "popover");
    if (theme === "dark") expect(contrast(raised, card)).toBeGreaterThan(1.05);
    else expect(contrast(raised, card)).toBeLessThan(1.05);
  });
});

test("the contrast helper measures as WCAG does", () => {
  const black = parseColour("#000");
  const white = parseColour("#ffffff");
  expect(contrast(black, white)).toBeCloseTo(21, 5);
  expect(contrast(white, white)).toBe(1);
  // A mix is channel-wise in sRGB: half black, half white is #808080 (to rounding).
  const grey = parseColour("color-mix(in srgb, #000000 50%, #ffffff)");
  expect(grey.r).toBeCloseTo(127.5, 5);
  expect(parseColour("rgb(0 0 0 / 0.6)").a).toBe(0.6);
  expect(() => contrast(parseColour("rgb(0 0 0 / 0.6)"), white)).toThrow();
});
