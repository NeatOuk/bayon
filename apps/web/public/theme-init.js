/* global window, document */
// Before first paint: put `.dark` on <html> from the operator's remembered pick, else
// from the system's appearance, so no screen — the login and "Connecting…" included — flashes the
// wrong theme. A classic, blocking, same-origin script: the edge's CSP (default-src 'self') refuses
// inline ones. It mirrors src/theme/theme.ts (key "bayon.theme", values "light" | "dark"), which it
// cannot import; src/theme/theme-init.test.ts holds the two together.
(() => {
  const readPick = () => {
    try {
      return window.localStorage.getItem("bayon.theme");
    } catch {
      return null;
    }
  };
  const pick = readPick();
  const dark =
    pick === "dark" ||
    (pick !== "light" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
