import { PtyFrameKind, decodePtyClientFrame } from "@bayon/proto";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TerminalTab } from "@/terminal/terminal-tab";
import { sessionView } from "@/test/fixtures";
import { renderWithProviders, stubFetch } from "@/test/render";

const { FakeTerm, terminals } = vi.hoisted(() => {
  class Term {
    readonly created: Readonly<Record<string, unknown>>;
    options: Record<string, unknown>;
    written: Uint8Array[] = [];
    #data: ((data: string) => void)[] = [];
    #resize: ((size: { cols: number; rows: number }) => void)[] = [];
    constructor(options: Record<string, unknown> = {}) {
      this.created = options;
      this.options = { ...options };
      terminals.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {}
    write(bytes: Uint8Array): void {
      this.written.push(bytes);
    }
    onData(cb: (data: string) => void) {
      this.#data.push(cb);
      return { dispose: () => undefined };
    }
    onResize(cb: (size: { cols: number; rows: number }) => void) {
      this.#resize.push(cb);
      return { dispose: () => undefined };
    }
    fireData(text: string): void {
      for (const h of this.#data) h(text);
    }
    fireResize(size: { cols: number; rows: number }): void {
      for (const h of this.#resize) h(size);
    }
  }
  const terminals: Term[] = [];
  return { FakeTerm: Term, terminals };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerm }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer });
  }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

let sockets: FakeWebSocket[] = [];

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  sockets = [];
  terminals.length = 0;
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

/** The nth item of `items`, or a clear failure — this project forbids `!`. */
function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`no item at index ${index}`);
  return found;
}
const socket = (i = 0): FakeWebSocket => at(sockets, i);
const terminal = (i = 0) => at(terminals, i);
const sentFrame = (i: number) => decodePtyClientFrame(at(socket().sent, i));

const attached = sessionView({
  id: "s1",
  state: "human_attached",
  attach_lease_owner: "lease-1",
});

test("not attached: no socket opens, shows a not-attached state", () => {
  renderWithProviders(
    <TerminalTab
      session={sessionView({ id: "s1", state: "idle" })}
      isLeaseHolder={false}
    />,
  );
  expect(sockets).toHaveLength(0);
  expect(screen.getByText("Not attached")).toBeTruthy();
});

test("connects to /ws/pty with the session id and lease, renders incoming bytes", () => {
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  expect(sockets).toHaveLength(1);
  expect(socket().url).toContain("/ws/pty?");
  expect(socket().url).toContain("sessionId=s1");
  expect(socket().url).toContain("lease=lease-1");

  const text = "hello\r\n";
  act(() => socket().open());
  act(() => socket().receive(new TextEncoder().encode(text)));
  expect(terminal().written).toHaveLength(1);
  expect(new TextDecoder().decode(at(terminal().written, 0))).toBe(text);
});

test("takes the theme's colours and the monospace font, with a visible cursor, and follows a theme switch", async () => {
  const tokens: Readonly<Record<string, string>> = {
    card: "CARD",
    foreground: "INK",
    danger: "DANGER",
    success: "GO",
  };
  vi.spyOn(
    CSSStyleDeclaration.prototype,
    "getPropertyValue",
  ).mockImplementation((name: string) => tokens[name.replace(/^--/, "")] ?? "");
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  expect(screen.getByTestId("terminal-container").className).toContain(
    "font-mono",
  );
  expect(terminal().created).toHaveProperty("fontFamily");
  expect(terminal().created.theme).toMatchObject({
    background: "CARD",
    cursor: "INK",
    red: "DANGER",
    green: "GO",
  });
  const before = terminal().options.theme;
  document.documentElement.classList.add("dark");
  await waitFor(() => expect(terminal().options.theme).not.toBe(before));
});

test("the lease holder's keystrokes and resizes are sent as Data/Resize frames", () => {
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  act(() => socket().open());

  act(() => terminal().fireData("ls\n"));
  const dataFrame = sentFrame(0);
  expect(dataFrame?.kind).toBe(PtyFrameKind.Data);
  if (dataFrame?.kind === PtyFrameKind.Data) {
    expect(new TextDecoder().decode(dataFrame.bytes)).toBe("ls\n");
  }

  act(() => terminal().fireResize({ cols: 100, rows: 40 }));
  expect(sentFrame(1)).toEqual({
    kind: PtyFrameKind.Resize,
    cols: 100,
    rows: 40,
  });
});

test("a watcher's keystrokes and resizes never leave the tab, and it renders read-only", () => {
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder={false} />);
  act(() => socket().open());

  act(() => terminal().fireData("rm -rf /\n"));
  act(() => terminal().fireResize({ cols: 80, rows: 24 }));
  expect(socket().sent).toHaveLength(0);
  expect(screen.getByText("someone else is attached — watching")).toBeTruthy();
});

const SESSION_URL = "/api/v1/sessions/s1";

test("a close while a fresh read still shows it attached reconnects once", async () => {
  stubFetch({ [SESSION_URL]: attached });
  vi.useFakeTimers();
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  act(() => socket().open());
  act(() => socket().drop());
  expect(screen.getByRole("alert").textContent).toBe("Disconnected");

  // One async advance covers both the fresh GET's microtask chain and the retry delay: fake timers
  // interleave flushing pending promises with advancing time across the whole span, unlike a plain
  // sync advance which never lets an in-flight fetch's .then() run at all.
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(sockets).toHaveLength(2);
  vi.useRealTimers();
});

test("a reconnect that also closes immediately, without ever opening, is not retried again", async () => {
  // own code review: a scheduled reconnect that also closed immediately (never
  // reaching `onopen`, so the retry budget never reset) used to schedule yet another retry — five
  // consecutive immediate closes produced six connection attempts, unboundedly.
  stubFetch({ [SESSION_URL]: attached });
  vi.useFakeTimers();
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  act(() => socket().open());
  act(() => socket().drop()); // 1st close: schedules the one retry
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(sockets).toHaveLength(2);

  act(() => socket(1).drop()); // the retry's own socket closes without ever opening
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(sockets).toHaveLength(2); // no third attempt: the one retry was already used
  vi.useRealTimers();
});

test("a close checked against a session no longer attached does not reconnect, even though the poll prop is stale", async () => {
  // The reconnect decision must use a fresh read, not the cached `attached` prop passed in — a
  // real detach/restart close (own proactive-close fix) can arrive well before this
  // tab's next poll would reflect it.
  stubFetch({ [SESSION_URL]: { ...attached, state: "idle" } });
  vi.useFakeTimers();
  renderWithProviders(<TerminalTab session={attached} isLeaseHolder />);
  act(() => socket().open());
  act(() => socket().drop());

  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(sockets).toHaveLength(1);
  vi.useRealTimers();
});
