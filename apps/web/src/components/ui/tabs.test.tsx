import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { classesIn, selectorsDeclaring, themeCss } from "@/test/theme-css";

// The registry Tabs style by orientation with data-horizontal: and data-vertical: (and their
// group-data-*/tabs: forms). base-ui sets data-orientation, so theme.css maps those variants onto it.
// These tests compile the rendered classes against the real theme and ask which rules match.

const stylesFor = (root: Element): Promise<string> => themeCss(classesIn(root));

const stacks = (css: string, el: Element): boolean =>
  selectorsDeclaring(css, "flex-direction: column").some((s) => el.matches(s));

function renderTabs(orientation?: "horizontal" | "vertical") {
  const { container } = render(
    <Tabs defaultValue="a" orientation={orientation}>
      <TabsList>
        <TabsTrigger value="a">A</TabsTrigger>
        <TabsTrigger value="b">B</TabsTrigger>
      </TabsList>
      <TabsContent value="a">panel a</TabsContent>
    </Tabs>,
  );
  const root = container.querySelector('[data-slot="tabs"]');
  const list = container.querySelector('[data-slot="tabs-list"]');
  if (root === null || list === null) throw new Error("no tabs rendered");
  return { root, list };
}

test("horizontal tabs (the default) stack the list over the panel; the triggers sit in a row", async () => {
  const { root, list } = renderTabs();
  expect(root.getAttribute("data-orientation")).toBe("horizontal");
  const css = await stylesFor(root);
  expect(stacks(css, root)).toBe(true);
  expect(stacks(css, list)).toBe(false);
});

test("vertical tabs put the list beside the panel and stack the triggers", async () => {
  const { root, list } = renderTabs("vertical");
  expect(root.getAttribute("data-orientation")).toBe("vertical");
  const css = await stylesFor(root);
  expect(stacks(css, root)).toBe(false);
  expect(stacks(css, list)).toBe(true);
});
