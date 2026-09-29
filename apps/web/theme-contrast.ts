// WCAG 2.x contrast for theme.css's tokens (colours.test.ts): reads the theme's primitive and
// semantic blocks, resolves a token for one theme — var() chains, hex, rgb() and the
// `color-mix(in srgb, …)` the soft tones use — and measures a pair the way WCAG does.

export type ThemeName = "light" | "dark";

/** A token's declarations, name (without `--`) to raw value. */
export type Declarations = Readonly<Record<string, string>>;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level `selector { … }` block without nested rules, keyed by its selector. */
export function blocks(css: string): ReadonlyMap<string, Declarations> {
  const found = new Map<string, Declarations>();
  for (const [, selector, body] of stripComments(css).matchAll(
    /(?:^|\n)([^\s@{}][^{}]*?)\s*\{([^{}]*)\}/g,
  )) {
    const key = (selector ?? "").replace(/\s+/g, " ").trim();
    const declarations = Object.fromEntries(
      [...(body ?? "").matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [
        m[1] ?? "",
        (m[2] ?? "").trim(),
      ]),
    );
    found.set(key, { ...found.get(key), ...declarations });
  }
  return found;
}

/**
 * What a theme sees on <html>: light is `:root`; dark is `:root` overridden by `.dark` (the class
 * sits on the root element); the shared semantic block applies to both.
 */
export function themeTokens(css: string, theme: ThemeName): Declarations {
  const all = blocks(css);
  const root = all.get(":root") ?? {};
  const semantic = all.get(":root, .dark") ?? {};
  return theme === "light"
    ? { ...root, ...semantic }
    : { ...root, ...(all.get(".dark") ?? {}), ...semantic };
}

/** Substitutes every `var(--name)` from `tokens`, however deep the chain. */
export function substitute(value: string, tokens: Declarations): string {
  let text = value;
  for (let depth = 0; text.includes("var("); depth += 1) {
    if (depth > 20) throw new Error(`var() cycle in ${value}`);
    text = text.replace(/var\(--([\w-]+)\)/g, (_, name: string) => {
      const next = tokens[name];
      if (next === undefined) throw new Error(`--${name} is not defined`);
      return next;
    });
  }
  return text;
}

/** Splits on commas that are not inside parentheses. */
function topLevelArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  return [...parts, current.trim()];
}

function parseHex(text: string): Rgb {
  const digits = text.slice(1);
  const full =
    digits.length === 3
      ? [...digits].map((d) => d + d).join("")
      : digits.slice(0, 6);
  const channel = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
  const alpha =
    digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1;
  return { r: channel(0), g: channel(2), b: channel(4), a: alpha };
}

function parseRgb(args: string): Rgb {
  const [channels = "", alpha] = args.split("/");
  const [r = 0, g = 0, b = 0] = channels
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  return { r, g, b, a: alpha === undefined ? 1 : Number(alpha.trim()) };
}

/** `color-mix(in srgb, A p%, B [q%])`: channel-wise, in gamma-encoded sRGB, as browsers mix it. */
function parseMix(args: string): Rgb {
  const [space, first = "", second = ""] = topLevelArgs(args);
  if (space !== "in srgb") throw new Error(`color-mix space ${space}`);
  const part = (text: string) => {
    const m = /^(.*?)(?:\s+(\d+(?:\.\d+)?)%)?$/.exec(text);
    return {
      colour: parseColour(m?.[1] ?? text),
      share: m?.[2] === undefined ? null : Number(m[2]) / 100,
    };
  };
  const a = part(first);
  const b = part(second);
  const p = a.share ?? (b.share === null ? 0.5 : 1 - b.share);
  const mix = (x: number, y: number) => x * p + y * (1 - p);
  if (a.colour.a !== 1 || b.colour.a !== 1)
    throw new Error("only opaque colours are mixed");
  return {
    r: mix(a.colour.r, b.colour.r),
    g: mix(a.colour.g, b.colour.g),
    b: mix(a.colour.b, b.colour.b),
    a: 1,
  };
}

/** A resolved colour value: hex, rgb()/rgba() or color-mix(in srgb, …). */
export function parseColour(text: string): Rgb {
  const value = text.trim();
  if (value.startsWith("#")) return parseHex(value);
  const fn = /^([\w-]+)\((.*)\)$/s.exec(value);
  if (fn?.[1] === "rgb" || fn?.[1] === "rgba") return parseRgb(fn[2] ?? "");
  if (fn?.[1] === "color-mix") return parseMix(fn[2] ?? "");
  throw new Error(`not a colour this helper reads: ${value}`);
}

/** A token's colour in one theme. */
export const tokenColour = (tokens: Declarations, name: string): Rgb => {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`--${name} is not defined`);
  return parseColour(substitute(raw, tokens));
};

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque colour. */
export const luminance = ({ r, g, b }: Rgb): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** WCAG contrast ratio, 1–21. Both colours must be opaque: a translucent one has no single ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  if (a.a !== 1 || b.a !== 1) throw new Error("contrast needs opaque colours");
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
