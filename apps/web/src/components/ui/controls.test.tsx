import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { selectorsDeclaring, themeCss } from "@/test/theme-css";

// The control foundations: one height scale, one focus ring, a disabled state that
// shows, and alerts in real tones. Class assertions stand in for layout jsdom cannot do.

const classes = (el: Element): string[] => [...el.classList];

test("buttons are fixed heights on one scale, icon sizes square", () => {
  const sizes = {
    default: "h-9",
    sm: "h-8",
    xs: "h-7",
    lg: "h-10",
    icon: "size-9",
    "icon-sm": "size-8",
    "icon-xs": "size-7",
    "icon-lg": "size-10",
  } as const;
  for (const [size, height] of Object.entries(sizes)) {
    const { unmount } = render(
      <Button size={size as keyof typeof sizes}>b</Button>,
    );
    const button = screen.getByRole("button");
    expect([size, classes(button)]).toEqual([
      size,
      expect.arrayContaining([height]),
    ]);
    expect(classes(button).some((c) => /^py-/.test(c))).toBe(false);
    unmount();
  }
});

test("inputs, selects and toggles sit on the button scale: h-9 by default, h-8 small", () => {
  render(
    <>
      <Input aria-label="input" />
      <Select>
        <SelectTrigger aria-label="default select">
          <SelectValue />
        </SelectTrigger>
      </Select>
      <Select>
        <SelectTrigger size="sm" aria-label="small select">
          <SelectValue />
        </SelectTrigger>
      </Select>
      <Toggle aria-label="toggle">t</Toggle>
      <Toggle size="sm" aria-label="small toggle">
        t
      </Toggle>
    </>,
  );
  expect(classes(screen.getByLabelText("input"))).toContain("h-9");
  expect(classes(screen.getByLabelText("default select"))).toContain(
    "data-[size=default]:h-9",
  );
  expect(classes(screen.getByLabelText("small select"))).toContain(
    "data-[size=sm]:h-8",
  );
  expect(classes(screen.getByLabelText("toggle"))).toContain("h-9");
  expect(classes(screen.getByLabelText("small toggle"))).toContain("h-8");
});

test("every control rings focus in the ring token, drawn solid even where it resets outline", () => {
  render(
    <>
      <Button>button</Button>
      <Input aria-label="input" />
      <Textarea aria-label="textarea" />
      <Checkbox aria-label="checkbox" />
      <Switch aria-label="switch" />
      <Toggle aria-label="toggle">t</Toggle>
      <Badge render={<a href="#/">badge</a>} />
    </>,
  );
  const controls = [
    screen.getByRole("button", { name: "button" }),
    screen.getByLabelText("input"),
    screen.getByLabelText("textarea"),
    screen.getByRole("checkbox"),
    screen.getByRole("switch"),
    screen.getByLabelText("toggle"),
    screen.getByRole("link", { name: "badge" }),
  ];
  for (const control of controls) {
    const list = classes(control);
    expect([control.outerHTML.slice(0, 40), list]).toEqual([
      expect.any(String),
      expect.arrayContaining([
        "focus-visible:outline-ring",
        "focus-visible:outline-solid",
      ]),
    ]);
    expect(list.join(" ")).not.toMatch(/outline-primary/);
  }
});

test("outline-none plus focus-visible:outline-solid really draws the ring (Tailwind v4)", async () => {
  const css = await themeCss([
    "outline-none",
    "focus-visible:outline-2",
    "focus-visible:outline-solid",
    "focus-visible:outline-ring",
  ]);
  expect(
    selectorsDeclaring(css, "outline-style: solid").some((s) =>
      s.includes(":focus-visible"),
    ),
  ).toBe(true);
  expect(selectorsDeclaring(css, "outline-color: var(--ring)")).not.toEqual([]);
});

test("a disabled button keeps pointer events, so the not-allowed cursor shows, and is dimmed", () => {
  render(<Button disabled>b</Button>);
  const list = classes(screen.getByRole("button"));
  expect(list).toEqual(
    expect.arrayContaining([
      "disabled:cursor-not-allowed",
      "disabled:opacity-50",
    ]),
  );
  expect(list).not.toContain("disabled:pointer-events-none");
  expect(list).not.toContain("data-disabled:pointer-events-none");
  // Hovers are guarded, so a disabled button never lights up.
  expect(list.filter((c) => c.startsWith("hover:"))).toEqual(
    list.filter((c) => c.startsWith("hover:not-disabled:")),
  );
});

test("a pressed toggle shows: the selected tint and a primary edge; outline toggles take the control edge", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Toggle aria-label="plain">t</Toggle>
      <Toggle variant="outline" aria-label="outlined">
        t
      </Toggle>
    </>,
  );
  const plain = screen.getByLabelText("plain");
  await user.click(plain);
  expect(plain.getAttribute("aria-pressed")).toBe("true");
  expect(classes(plain)).toEqual(
    expect.arrayContaining([
      "border-transparent",
      "aria-pressed:bg-selected",
      "aria-pressed:border-primary",
    ]),
  );
  expect(classes(screen.getByLabelText("outlined"))).toContain(
    "border-input-border",
  );
});

test("inputs take the 3:1 control edge, not the surface hairline", () => {
  render(<Input aria-label="input" />);
  expect(classes(screen.getByLabelText("input"))).toContain(
    "border-input-border",
  );
});

test("the dialog's backdrop dims with the overlay token", () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>t</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  expect(overlay === null ? [] : classes(overlay)).toContain("bg-overlay");
  const content = document.querySelector('[data-slot="dialog-content"]');
  expect(content === null ? [] : classes(content)).toEqual(
    expect.arrayContaining(["bg-popover", "border", "shadow-lg"]),
  );
});

test("alert statuses are real tones: a soft surface, a tone edge, the title in the tone", () => {
  const tones = {
    error: "danger",
    success: "success",
    warning: "warning",
    info: "info",
  } as const;
  for (const [status, tone] of Object.entries(tones)) {
    const { unmount } = render(
      <Alert status={status as keyof typeof tones}>
        <AlertTitle>title</AlertTitle>
        <AlertDescription>body</AlertDescription>
      </Alert>,
    );
    const list = classes(screen.getByRole("alert"));
    expect([status, list]).toEqual([
      status,
      expect.arrayContaining([
        `bg-${tone}-subtle`,
        `border-${tone}/50`,
        `*:data-[slot=alert-title]:text-${tone}`,
        "*:data-[slot=alert-description]:text-foreground",
      ]),
    ]);
    // The default variant's colours give way to the tone's.
    expect(list).not.toContain("bg-card");
    expect(list).not.toContain(
      "*:data-[slot=alert-description]:text-muted-foreground",
    );
    unmount();
  }
});

test("badges carry the status tones", () => {
  render(
    <>
      <Badge variant="success">ok</Badge>
      <Badge variant="warning">careful</Badge>
      <Badge variant="info">note</Badge>
    </>,
  );
  expect(classes(screen.getByText("ok"))).toContain("bg-success");
  expect(classes(screen.getByText("careful"))).toContain("bg-warning");
  expect(classes(screen.getByText("note"))).toContain("bg-info");
});

test("an off switch is an outlined track with a visible thumb; on is a primary track", async () => {
  const user = userEvent.setup();
  render(<Switch aria-label="switch" />);
  const track = screen.getByRole("switch");
  const thumb = track.querySelector('[data-slot="switch-thumb"]');
  expect(track.getAttribute("aria-checked")).toBe("false");
  expect(classes(track)).toEqual(
    expect.arrayContaining([
      "border-input-border",
      "bg-muted",
      "data-checked:border-primary",
      "data-checked:bg-primary",
    ]),
  );
  // The thumb never takes a surface colour, so it cannot vanish into the track.
  expect(thumb === null ? [] : classes(thumb)).toEqual(
    expect.arrayContaining([
      "bg-muted-foreground",
      "data-checked:bg-primary-foreground",
    ]),
  );
  expect(thumb === null ? [] : classes(thumb)).not.toContain("bg-background");
  await user.click(track);
  expect(track.getAttribute("aria-checked")).toBe("true");
  expect(track.hasAttribute("data-checked")).toBe(true);
  expect(thumb?.hasAttribute("data-checked")).toBe(true);
});

test("an unchecked checkbox has the control edge on the input fill; checked is a primary box", () => {
  render(<Checkbox aria-label="checkbox" />);
  expect(classes(screen.getByRole("checkbox"))).toEqual(
    expect.arrayContaining([
      "border-input-border",
      "bg-input",
      "data-checked:border-primary",
      "data-checked:bg-primary",
      "text-primary-foreground",
    ]),
  );
});
