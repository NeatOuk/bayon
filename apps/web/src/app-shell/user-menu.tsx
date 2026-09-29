import { CircleUserRoundIcon, LogOutIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ThemeChoice } from "@/theme/theme";
import { THEME_LABEL, ThemeMenuItems } from "@/theme/theme-menu";

/**
 * The top bar's user menu: the theme (System / Light / Dark) and, behind the production
 * edge, Log out. The operator's own settings are the sidebar's Settings; this holds the viewer's.
 */
export function UserMenu({
  theme,
  onTheme,
  onLogout,
}: {
  readonly theme: ThemeChoice;
  readonly onTheme: (choice: ThemeChoice) => void;
  readonly onLogout: (() => void) | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="User menu"
        title={`User menu · theme: ${THEME_LABEL[theme]}`}
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <CircleUserRoundIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="User menu">
        <ThemeMenuItems choice={theme} onChoose={onTheme} />
        {onLogout !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
