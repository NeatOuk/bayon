import { useCallback, useState } from "react";
import { usePaletteShortcut } from "@/app-shell/command-palette";
import { createDialogHandle, type DialogHandle } from "@/components/ui/dialog";
import { createSheetHandle, type SheetHandle } from "@/components/ui/sheet";

export interface Overlay<Handle> {
  /** Links the overlay to its trigger in the top bar. */
  readonly handle: Handle;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The shell's two overlays: the narrow sidebar sheet and the command palette. Any
 * navigation (`hash` moving: a pick in the sheet, the palette, back and forward) closes the sheet;
 * ⌘K / Ctrl+K toggles the palette, closing the sheet first.
 */
export function useOverlays(hash: string): {
  readonly menu: Overlay<SheetHandle>;
  readonly palette: Overlay<DialogHandle>;
} {
  const [menuHandle] = useState(createSheetHandle);
  const [paletteHandle] = useState(createDialogHandle);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [seenHash, setSeenHash] = useState(hash);
  if (hash !== seenHash) {
    setSeenHash(hash);
    setMenuOpen(false);
  }
  const togglePalette = useCallback(() => {
    setMenuOpen(false);
    setPaletteOpen((open) => !open);
  }, []);
  usePaletteShortcut(togglePalette);
  return {
    menu: { handle: menuHandle, open: menuOpen, onOpenChange: setMenuOpen },
    palette: {
      handle: paletteHandle,
      open: paletteOpen,
      onOpenChange: setPaletteOpen,
    },
  };
}
