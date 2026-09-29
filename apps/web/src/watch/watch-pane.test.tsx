import { FakeClock } from "@bayon/core";
import {
  CursorClient,
  sessionEventsTopic,
  type EventItem,
  type OnEvents,
} from "@bayon/proto";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Feed } from "@/feed/feed";
import { FakeSocket } from "@/test/fake-socket";
import { error, text, toolCall, turnStart } from "@/test/fixtures";
import { renderWithProviders, silentFeed, stubFetch } from "@/test/render";
import { Timeline } from "@/timeline/timeline";
import { WatchPane } from "@/watch/watch-pane";

// The Watch pane: a read-only terminal of a session's events topic. xterm.js is faked —
// what matters is what the pane asks of it (options, writes) and what it never does (read input).
const { FakeTerm, terminals } = vi.hoisted(() => {
  class Term {
    readonly created: Readonly<Record<string, unknown>>;
    options: Record<string, unknown>;
    written: string[] = [];
    dataHandlers = 0;
    disposed = false;
    constructor(options: Record<string, unknown> = {}) {
      this.created = options;
      this.options = { ...options };
      terminals.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    dispose(): void {
      this.disposed = true;
    }
    write(data: string): void {
      this.written.push(data);
    }
    onData() {
      this.dataHandlers += 1;
      return { dispose: () => undefined };
    }
    /** Everything written, without the pane's ANSI styling. */
    text(): string {
      // eslint-disable-next-line no-control-regex -- stripping the pane's own SGR codes
      return this.written.join("").replace(/\x1b\[[0-9;]*m/g, "");
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

let sockets: string[] = [];
/** Any socket the pane might open: it must open none. */
class RecordingWebSocket {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    sockets.push(url);
  }
}

beforeEach(() => {
  terminals.length = 0;
  sockets = [];
  vi.stubGlobal("WebSocket", RecordingWebSocket);
});
afterEach(() => {
  document.documentElement.classList.remove("dark");
});

const term = () => {
  const found = terminals.at(-1);
  if (found === undefined) throw new Error("no terminal was created");
  return found;
};

/** A feed whose session events the test pushes: the listener the pane subscribed. */
function pushEvents() {
  let on: OnEvents | undefined;
  const feed: Feed = {
    ...silentFeed,
    subscribeEvents: (_sessionId, listener) => {
      on = listener;
      return () => {
        on = undefined;
      };
    },
  };
  const push = (items: EventItem[]) =>
    act(() => {
      if (on === undefined) throw new Error("the pane did not subscribe");
      on(items, items.at(-1)?.id ?? 0);
    });
  return { feed, push };
}

test("renders the stream's events as terminal lines, and never sends input anywhere", () => {
  const fetchMock = stubFetch({});
  const { feed, push } = pushEvents();
  renderWithProviders(<WatchPane sessionId="s1" />, { feed });

  expect(term().created).toMatchObject({ disableStdin: true });
  push([turnStart(1), text(2, "reading the tests"), toolCall(3)]);
  expect(term().text()).toBe(
    '── turn · 08:00:01 ──\nreading the tests\n▸ shell {"cmd":"pnpm test"}\n',
  );
  push([error(4, "boom")]);
  expect(term().text()).toContain("✖ runner_error: boom\n");

  // Read-only: no keystroke handler at all, no socket of its own, no request.
  expect(term().dataHandlers).toBe(0);
  expect(sockets).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByText(/typing here sends nothing/)).toBeTruthy();
});

test("follows live: each frame writes only what is new, and a replay writes nothing twice", () => {
  const { feed, push } = pushEvents();
  renderWithProviders(<WatchPane sessionId="s1" />, { feed });
  push([text(1), text(2)]);
  push([text(2), text(3)]);
  expect(term().written).toHaveLength(2);
  expect(term().text()).toBe("text 1\ntext 2\ntext 3\n");
});

test("re-reads the theme's colours when dark mode is toggled", async () => {
  renderWithProviders(<WatchPane sessionId="s1" />);
  const before = term().options.theme;
  document.documentElement.classList.add("dark");
  await waitFor(() => expect(term().options.theme).not.toBe(before));
});

test("Watch and Timeline on one session both update from the one topic (fan-out)", () => {
  const clock = new FakeClock(0);
  const socket = new FakeSocket();
  const client = new CursorClient({
    connect: () => socket,
    clock,
    onError: () => undefined,
  });
  renderWithProviders(
    <>
      <Timeline sessionId="s1" />
      <WatchPane sessionId="s1" />
    </>,
    { feed: client },
  );
  act(() => socket.open());
  const topic = sessionEventsTopic("s1");
  const frame = (items: EventItem[]) =>
    act(() =>
      socket.receive({
        type: "events",
        topic,
        cursor: items.at(-1)?.id ?? 0,
        items,
      }),
    );
  const rowIds = () =>
    screen.queryAllByTestId("event-row").map((r) => Number(r.dataset.eventId));

  frame([text(1, "one"), text(2, "two")]);
  expect(rowIds()).toEqual([1, 2]);
  expect(term().text()).toBe("one\ntwo\n");

  frame([text(3, "three")]);
  expect(rowIds()).toEqual([1, 2, 3]);
  expect(term().text()).toBe("one\ntwo\nthree\n");
  client.close();
});
