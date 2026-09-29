import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from "lucide-react";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { parseChoice, THEME_CHOICES, type ThemeChoice } from "@/theme/theme";

export const THEME_LABEL: Readonly<Record<ThemeChoice, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const THEME_ICON: Readonly<Record<ThemeChoice, LucideIcon>> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
};

/**
 * The theme choice as a menu's radio group, System / Light / Dark, the current one
 * checked. System follows the operating system's appearance; either pick is remembered. It lives in
 * the user menu, inside a DropdownMenuContent.
 */
export function ThemeMenuItems({
  choice,
  onChoose,
}: {
  readonly choice: ThemeChoice;
  readonly onChoose: (choice: ThemeChoice) => void;
}) {
  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={choice}
        onValueChange={(value) => onChoose(parseChoice(value))}
      >
        {THEME_CHOICES.map((option) => {
          const Icon = THEME_ICON[option];
          return (
            <DropdownMenuRadioItem key={option} value={option} closeOnClick>
              <Icon />
              {THEME_LABEL[option]}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
