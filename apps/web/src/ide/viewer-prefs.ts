/**
 * A viewer's on/off conveniences (the IDE's activity panel open or folded), in this browser's
 * `localStorage`. Nothing here must survive: storage can throw or come back empty (a private window,
 * blocked or cleared site data), and then the default holds and the page works the same.
 */
export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Blocked storage: the choice lasts until the page reloads, which is all it is for.
  }
}
