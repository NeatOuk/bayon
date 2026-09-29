import { compile } from "tailwindcss";
import tailwind from "tailwindcss/index.css?raw";
// By path: the package's export map offers the sheet only under the "style" condition.
import animate from "../../node_modules/tw-animate-css/dist/tw-animate.css?raw";
import theme from "@/theme.css?raw";

// theme.css compiled by Tailwind, as the build compiles it, so a test can ask which rules a class
// list produces (tabs.test.tsx, controls.test.tsx). Its two @imports come from the installed files.
const SHEETS: Readonly<Record<string, string>> = {
  tailwindcss: tailwind,
  "tw-animate-css": animate,
};

/** The CSS the real theme generates for `classes`, base layer included. */
export async function themeCss(classes: readonly string[]): Promise<string> {
  const compiler = await compile(theme, {
    loadStylesheet: async (id, base) => {
      const content = SHEETS[id];
      if (content === undefined) throw new Error(`unexpected @import ${id}`);
      return { path: id, base, content };
    },
  });
  return compiler.build([...classes]);
}

/** The classes on `root` and everything under it. */
export const classesIn = (root: Element): string[] =>
  [root, ...root.querySelectorAll("*")].flatMap((el) => [...el.classList]);

/** The selectors of the innermost rules that declare `declaration`. */
export const selectorsDeclaring = (
  css: string,
  declaration: string,
): string[] =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => body?.includes(declaration))
    .map(([, selector]) => selector?.trim() ?? "");
