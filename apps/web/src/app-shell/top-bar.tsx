import { MenuIcon, SearchIcon } from "lucide-react";
import { SHORTCUT_LABEL } from "@/app-shell/palette-model";
import { UserMenu } from "@/app-shell/user-menu";
import { FOCUS_RING } from "@/components/text-link";
import { Button } from "@/components/ui/button";
import { DialogTrigger, type DialogHandle } from "@/components/ui/dialog";
import { SheetTrigger, type SheetHandle } from "@/components/ui/sheet";
import { FeedIndicator } from "@/feed/feed-indicator";
import { PauseSwitch } from "@/fleet/pause-switch";
import { ProjectSwitcher } from "@/ide/project-switcher";
import { cn } from "@/lib/utils";
import { FLEET_HREF, type Route } from "@/routing";
import type { ThemeChoice } from "@/theme/theme";

/**
 * The slim top bar, one row at every width from 320px: the menu button (narrow only),
 * the wordmark and project switcher, then Search, the feed light, the fleet pause in words and the
 * user menu. The screens themselves are the sidebar's.
 */
export function TopBar({
  route,
  narrow,
  menu,
  palette,
  theme,
  onTheme,
  onLogout,
}: {
  readonly route: Route;
  /** Below `lg`: the sidebar is a sheet, opened here. */
  readonly narrow: boolean;
  readonly menu: SheetHandle;
  readonly palette: DialogHandle;
  /** System, or the operator's remembered pick. */
  readonly theme: ThemeChoice;
  readonly onTheme: (choice: ThemeChoice) => void;
  readonly onLogout: (() => void) | null;
}) {
  const project = route.name === "project" ? route.project : null;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-card px-2 text-card-foreground sm:px-4 md:gap-3">
      {narrow && (
        <SheetTrigger
          handle={menu}
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Navigation" />
          }
        >
          <MenuIcon />
        </SheetTrigger>
      )}
      <a
        href={FLEET_HREF}
        className={cn(
          FOCUS_RING,
          "hidden shrink-0 rounded-xs font-head text-base font-semibold tracking-wide sm:block",
        )}
      >
        BAYON
      </a>
      <div className="hidden min-w-0 shrink sm:block">
        <ProjectSwitcher value={project} className="w-36 md:w-44" />
      </div>
      <div className="ml-auto flex min-w-0 items-center gap-2 md:gap-3">
        <DialogTrigger
          handle={palette}
          aria-label="Search everywhere"
          aria-keyshortcuts="Meta+K Control+K"
          render={
            <Button
              variant="outline"
              size="sm"
              className="min-w-0 shrink justify-start font-normal text-muted-foreground max-sm:size-8 max-sm:shrink-0 max-sm:justify-center max-sm:px-0 sm:w-40 md:w-56 lg:w-64"
            />
          }
        >
          <SearchIcon aria-hidden="true" />
          <span className="truncate max-sm:sr-only">Search…</span>
          <kbd className="ml-auto hidden rounded-sm border bg-muted px-1.5 font-mono text-xs sm:inline">
            {SHORTCUT_LABEL}
          </kbd>
        </DialogTrigger>
        <FeedIndicator />
        <PauseSwitch />
        <UserMenu theme={theme} onTheme={onTheme} onLogout={onLogout} />
      </div>
    </header>
  );
}
