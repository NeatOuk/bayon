import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useSessionEvents } from "@/feed/use-session-events";
import { cn } from "@/lib/utils";
import { watchLines } from "@/watch/watch-lines";
import { followTheme, terminalTheme } from "@/lib/terminal-theme";

/** Enough history to scroll back through a long turn; the Timeline holds the whole session. */
const SCROLLBACK_LINES = 5_000;

/**
 * Watch: a live, read-only, terminal-style view of a session, rendered from its events
 * topic — the same `session:<id>:events` the Timeline reads, as a second listener on one topic
 * (fan-out). It never touches the agent: no socket of its own, no stdin, no keystroke
 * handler; nothing typed here goes anywhere. It follows the tail as events arrive, unless the
 * operator has scrolled up to read.
 */
export function WatchPane({
  sessionId,
  className,
}: {
  readonly sessionId: string;
  /** The terminal's box: its height, where the parent does not give one. */
  readonly className?: string;
}) {
  const { items } = useSessionEvents(sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  /** How many of `items` this terminal has written. */
  const writtenRef = useRef(0);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const term = new XTerm({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: SCROLLBACK_LINES,
      // The container's own font-mono stack: the theme's JetBrains Mono, from its CSS, not here.
      fontFamily: getComputedStyle(container).fontFamily,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    writtenRef.current = 0;
    const resize = new ResizeObserver(() => fit.fit());
    resize.observe(container);
    const unfollow = followTheme(term);
    return () => {
      unfollow();
      resize.disconnect();
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term === null || items.length <= writtenRef.current) return;
    term.write(items.slice(writtenRef.current).map(watchLines).join(""));
    writtenRef.current = items.length;
  }, [items, sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        read-only · follows the session live · typing here sends nothing
      </p>
      <div
        ref={containerRef}
        data-testid="watch-container"
        aria-label={`watch ${sessionId}`}
        className={cn(
          "min-h-0 flex-1 overflow-hidden rounded-lg border bg-card p-1 font-mono",
          className,
        )}
      />
    </div>
  );
}
