import type { ProjectView } from "@bayon/proto";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { useQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  paletteGroups,
  parseRecent,
  RECENT_KEY,
  withRecent,
  type PaletteGroup,
  type PaletteItem,
} from "@/app-shell/palette-model";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  type DialogHandle,
} from "@/components/ui/dialog";
import { projectsQuery } from "@/projects/projects-api";
import { projectHref, ticketHref, type Route } from "@/routing";

// The command palette: ⌘K / Ctrl+K or the top bar's Search. base-ui's Autocomplete,
// inline in a Dialog — the pattern its docs publish for a palette — gives the combobox and listbox
// roles, the grouped options, arrow keys, Enter, and (from the Dialog) Esc, the focus trap and focus
// return. Nothing new is fetched: the screens are the nav model's, the projects and their agents the
// switcher's query.

const readRecent = (): readonly PaletteItem[] => {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
};

const writeRecent = (recent: readonly PaletteItem[]): void => {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Blocked storage: Recent is a convenience, and the pick still navigates.
  }
};

/** Focus inside a terminal: Ctrl+K is the shell's there (kill to end of line), so it is left alone. */
const inTerminal = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(".xterm") !== null;

/** ⌘K / Ctrl+K anywhere calls `toggle`; `toggle` must be stable. */
export function usePaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey)
        return;
      if (!event.metaKey && !(event.ctrlKey && !inTerminal(event.target)))
        return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** Where "open ticket N" goes: inside a project, a tab beside its view; else the ticket's screen. */
const ticketLink =
  (route: Route) =>
  (num: number): string =>
    route.name === "project"
      ? projectHref(route.project, route.view, { kind: "ticket", num })
      : ticketHref(num);

export function CommandPalette({
  open,
  onOpenChange,
  handle,
  route,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Links the top bar's Search button, which lives elsewhere in the tree. */
  readonly handle: DialogHandle;
  readonly route: Route;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} handle={handle}>
      <DialogContent
        size="md"
        showCloseButton={false}
        className="top-[10dvh] translate-y-0 gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* Mounted only while open, so each opening starts from an empty query and fresh Recent. */}
        {open && (
          <PaletteBody route={route} onDone={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({
  route,
  onDone,
}: {
  readonly route: Route;
  readonly onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [recent] = useState(readRecent);
  const hintId = useId();
  const projects = useQuery(projectsQuery);
  const all: readonly ProjectView[] = projects.data?.projects ?? [];
  const current =
    route.name === "project"
      ? (all.find((project) => project.id === route.project) ?? null)
      : null;
  const groups = paletteGroups(query, {
    projects: all,
    current,
    ticketHref: ticketLink(route),
    recent,
  });

  const choose = (item: PaletteItem, group: string) => {
    writeRecent(withRecent(recent, item, group));
    onDone();
    window.location.hash = item.href;
  };

  return (
    <Autocomplete.Root
      open
      inline
      items={groups}
      filteredItems={groups}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(item: PaletteItem) => item.label}
      autoHighlight="always"
      keepHighlight
    >
      <div className="flex items-center gap-2 border-b px-3">
        <SearchIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Autocomplete.Input
          aria-label="Search screens, projects, agents and tickets"
          aria-describedby={hintId}
          placeholder="Search screens, projects, agents, or #ticket…"
          className="h-11 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-[min(60dvh,26rem)] overflow-y-auto overscroll-contain p-1">
        {/* Always rendered; its content (and so its space) only when nothing matches. */}
        <Autocomplete.Empty>
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing matches.
          </p>
        </Autocomplete.Empty>
        <Autocomplete.List>
          {(group: PaletteGroup) => (
            <Autocomplete.Group
              key={group.value}
              items={group.items}
              className="not-last:mb-1"
            >
              <Autocomplete.GroupLabel className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                {group.value}
              </Autocomplete.GroupLabel>
              <Autocomplete.Collection>
                {(item: PaletteItem) => (
                  <Autocomplete.Item
                    key={item.id}
                    value={item}
                    onClick={() => choose(item, group.value)}
                    className="flex min-h-9 cursor-default items-center gap-3 rounded-md px-2 text-sm outline-none select-none data-highlighted:bg-selected data-highlighted:text-selected-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {item.hint !== undefined && (
                      <span className="shrink-0 truncate text-xs text-muted-foreground">
                        {item.hint}
                      </span>
                    )}
                  </Autocomplete.Item>
                )}
              </Autocomplete.Collection>
            </Autocomplete.Group>
          )}
        </Autocomplete.List>
      </div>
      <p
        id={hintId}
        className="flex items-center gap-3 border-t bg-muted px-3 py-2 text-xs text-muted-foreground"
      >
        <span>↑↓ to move</span>
        <span>Enter to open</span>
        <span>Esc to close</span>
      </p>
    </Autocomplete.Root>
  );
}
