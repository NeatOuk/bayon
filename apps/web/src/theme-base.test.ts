import { expect, test } from "vitest";
import { selectorsDeclaring, themeCss } from "@/test/theme-css";

// What theme.css itself contributes beyond tokens: the popups' enter/exit animations
// actually exist, motion stops for an operator who asks for less, and the base type scale.

test("the popups' animation classes compile to real keyframes (tw-animate-css is imported)", async () => {
  const css = await themeCss([
    "data-open:animate-in",
    "data-open:fade-in-0",
    "data-open:zoom-in-95",
    "data-closed:animate-out",
  ]);
  expect(css).toMatch(/@keyframes enter\b/);
  expect(css).toMatch(/@keyframes exit\b/);
  expect(selectorsDeclaring(css, "animation: enter")).not.toEqual([]);
});

test("prefers-reduced-motion cuts every animation and transition short", async () => {
  const css = await themeCss([]);
  const reduced = css.slice(css.indexOf("prefers-reduced-motion: reduce"));
  expect(reduced).not.toBe(css);
  expect(reduced).toMatch(/animation-duration: 0\.01ms !important/);
  expect(reduced).toMatch(/transition-duration: 0\.01ms !important/);
});

test("body text is 14px with a comfortable line; h1–h4 are semibold", async () => {
  const css = await themeCss([]);
  const body = /\n\s*body \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(body).toMatch(/font-size: var\(--text-sm\)/);
  expect(body).toMatch(
    /line-height: var\(--leading-normal\)|line-height: 1\.5/,
  );
  const headings = /h1, h2, h3, h4 \{([^}]*)\}/.exec(
    css.replace(/,\s+/g, ", "),
  )?.[1];
  expect(headings).toMatch(/font-weight: 600/);
});
