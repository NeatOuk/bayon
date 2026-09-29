import {
  encodePtyData,
  encodePtyHeartbeat,
  encodePtyResize,
  type SessionView,
} from "@bayon/proto";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { fetchSession } from "@/api/queries";
import { StatusBadge } from "@/components/status-badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  followTheme,
  TAKEOVER_SLOTS,
  terminalTheme,
} from "@/lib/terminal-theme";

/** Well under lifecycle.attach_lease_ms's 15-minute default (§12.5's named renewal mechanism). */
const HEARTBEAT_MS = 2 * 60_000;
/** At most one retry, after a short pause, for a close that a *fresh* read still shows attached —
 * a network blip, not the attach actually ending. an earlier change now closes this socket proactively on a
 * real detach/restart, so a close while still `human_attached` is the transient case worth retrying.
 * Bounded, not looping: a `session.state` poll can lag up to `SESSION_REFRESH_MS` behind reality, so
 * checking that cached prop again would let a flapping connection retry forever against something
 * already gone — one fresh `GET` settles it instead of trusting a stale value a second time. */
const RECONNECT_DELAY_MS = 2_000;

const ptyUrl = (
  location: Pick<Location, "protocol" | "host">,
  sessionId: string,
  lease: string | null,
): string => {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ sessionId, lease: lease ?? "" });
  return `${scheme}//${location.host}/ws/pty?${params.toString()}`;
};

type Status = "connecting" | "open" | "closed";

/** `WebSocket.send`'s DOM type wants a concretely `ArrayBuffer`-backed view; `encodePty*` return a
 * `Uint8Array` typed against the wider `ArrayBufferLike` (it's always a plain `ArrayBuffer` at
 * runtime, `new Uint8Array(n)` never allocates a `SharedArrayBuffer`). */
const sendBytes = (ws: WebSocket, bytes: Uint8Array): void =>
  ws.send(bytes as Uint8Array<ArrayBuffer>);

/**
 * §12.5 point 3, the Terminal tab: a raw (non-`CursorClient`) WebSocket to `/ws/pty`, xterm.js for
 * rendering. `isLeaseHolder` gates every outbound frame — a watcher's keystrokes/resizes never
 * leave this component, since a write from it would just be dropped server-side anyway,
 * and a UI that looked like it worked while doing nothing would be worse than one that's plainly
 * read-only.
 */
export function TerminalTab({
  session,
  isLeaseHolder,
}: {
  readonly session: SessionView;
  readonly isLeaseHolder: boolean;
}) {
  const attached = session.state === "human_attached";
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const isLeaseHolderRef = useRef(isLeaseHolder);
  isLeaseHolderRef.current = isLeaseHolder;

  useEffect(() => {
    if (!attached || containerRef.current === null) return;
    const container = containerRef.current;
    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      // The container's own font-mono stack and the theme's tokens, as the Watch pane has them.
      fontFamily: getComputedStyle(container).fontFamily,
      theme: terminalTheme(TAKEOVER_SLOTS),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    const unfollow = followTheme(term, TAKEOVER_SLOTS);

    let ws: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    // At most one retry per close: set the moment a close schedules one, cleared again only by a
    // reconnect that actually opens — so a burst of immediately-failing attempts stops after one
    // retry, while a connection that later blips again (long after a prior retry succeeded) still
    // gets its own fresh one.
    let retried = false;

    function connect(): void {
      setStatus("connecting");
      const socket = new WebSocket(
        ptyUrl(location, session.id, session.attach_lease_owner),
      );
      socket.binaryType = "arraybuffer";
      ws = socket;
      socket.onopen = () => {
        retried = false;
        setStatus("open");
      };
      socket.onmessage = (event) => {
        term.write(new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => {
        if (stopped) return;
        setStatus("closed");
        if (retried) return; // already used this episode's one retry
        retried = true;
        // A poll's cached `attached` can lag reality by up to SESSION_REFRESH_MS — trusting it here
        // would let a flapping connection retry forever against a session already gone. One fresh
        // read settles it: reconnect only if the session is *right now* still human_attached.
        void fetchSession(session.id)
          .then((fresh) => {
            if (!stopped && fresh.state === "human_attached") {
              reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
            }
          })
          .catch(() => undefined);
      };
    }
    connect();

    const dataSub = term.onData((data) => {
      if (!isLeaseHolderRef.current || ws?.readyState !== WebSocket.OPEN)
        return;
      sendBytes(ws, encodePtyData(new TextEncoder().encode(data)));
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (!isLeaseHolderRef.current || ws?.readyState !== WebSocket.OPEN)
        return;
      sendBytes(ws, encodePtyResize(cols, rows));
    });
    const heartbeat = setInterval(() => {
      if (!isLeaseHolderRef.current || ws?.readyState !== WebSocket.OPEN)
        return;
      sendBytes(ws, encodePtyHeartbeat());
    }, HEARTBEAT_MS);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(container);

    return () => {
      stopped = true;
      unfollow();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      clearInterval(heartbeat);
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      ws?.close();
      term.dispose();
    };
    // Re-opens only when the session id changes or an attach starts/ends — not on every poll tick;
    // a still-attached poll's fresh `attach_lease_owner` is read at connect() time either way.
  }, [attached, session.id]);

  if (!attached) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Not attached</EmptyTitle>
          <EmptyDescription>
            Attach above to take over this session's terminal.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {!isLeaseHolder && <span>someone else is attached — watching</span>}
        {/* The terminal's own socket, read as the feed's states: connecting, then open or lost. */}
        {status === "connecting" && (
          <span role="status">
            <StatusBadge entity="feed" state="connecting" label="Connecting…" />
          </span>
        )}
        {status === "closed" && (
          <span role="alert">
            <StatusBadge
              entity="feed"
              state="reconnecting"
              label="Disconnected"
            />
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        data-testid="terminal-container"
        className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card p-1 font-mono"
      />
    </div>
  );
}
