import { ok } from "@bayon/core";
import type { SessionView } from "@bayon/proto";
import { expect, test } from "vitest";
import type { ApiStore } from "../store.js";
import type { Channel, RelayClient } from "../relay/relay-client.js";
import { PtyHub, type HubSocket } from "./pty-hub.js";

const session = (patch: Partial<SessionView> = {}): SessionView =>
  ({
    state: "human_attached",
    attach_lease_owner: "lease-1",
    pty_log_path: null,
    ...patch,
  }) as SessionView;

/** A fake relay whose channels are driven by hand: `closeChannel(id)` fires that channel's
 * `onClose`, matching how a real disconnect or supervisor-side detach would. */
function fakeRelay(): RelayClient & {
  openCount: number;
  closeChannel(id: string): void;
} {
  const channels = new Map<string, { onClose?: (reason: string) => void }>();
  let openCount = 0;
  return {
    get openCount() {
      return openCount;
    },
    openChannel(channelId: string): Channel {
      openCount++;
      const reg: { onClose?: (reason: string) => void } = {};
      channels.set(channelId, reg);
      return {
        send: () => undefined,
        onData: () => undefined,
        onClose: (cb) => {
          reg.onClose = cb;
        },
        close: () => undefined,
      };
    },
    close: () => undefined,
    closeChannel(channelId: string): void {
      channels.get(channelId)?.onClose?.("closed for test");
    },
  };
}

const fakeStore = (view: SessionView): ApiStore =>
  ({ session: () => Promise.resolve(ok(view)) }) as unknown as ApiStore;

const fakeSocket = (): HubSocket & { closed: boolean } => {
  const socket = {
    readyState: 1,
    closed: false,
    send: () => undefined,
    close: () => {
      socket.closed = true;
    },
  };
  return socket;
};

test("a session whose channel closes is evicted, and re-opening it opens a fresh channel", async () => {
  const relay = fakeRelay();
  const hub = new PtyHub(relay, fakeStore(session()), () =>
    Promise.resolve(Buffer.alloc(0)),
  );
  const watcher = fakeSocket();
  const first = await hub.open("s1");
  first?.watch(watcher);
  expect(relay.openCount).toBe(1);

  relay.closeChannel("s1"); // the operator detached, or the supervisor restarted
  expect(watcher.closed).toBe(true); // told, not left in silence

  const second = await hub.open("s1");
  expect(relay.openCount).toBe(2); // a genuinely fresh channel, not the dead one
  expect(second).not.toBe(first);
});

test("watching an already-dead session closes the socket instead of joining a stale one", async () => {
  const relay = fakeRelay();
  const hub = new PtyHub(relay, fakeStore(session()), () =>
    Promise.resolve(Buffer.alloc(0)),
  );
  const first = await hub.open("s1");
  relay.closeChannel("s1");
  const watcher = fakeSocket();
  first?.watch(watcher); // a caller that already held the reference before it died
  expect(watcher.closed).toBe(true);
});

test("two concurrent opens for the same session share one channel, not two", async () => {
  const relay = fakeRelay();
  let releaseSession: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const store: ApiStore = {
    session: async () => {
      await gate; // hold both callers in the race window at once
      return ok(session());
    },
  } as unknown as ApiStore;
  const hub = new PtyHub(relay, store, () => Promise.resolve(Buffer.alloc(0)));

  const racing = Promise.all([hub.open("s1"), hub.open("s1")]);
  releaseSession?.();
  const [a, b] = await racing;

  expect(relay.openCount).toBe(1);
  expect(a).toBe(b);
});

test("release only closes the session once every watcher has left", async () => {
  const relay = fakeRelay();
  const hub = new PtyHub(relay, fakeStore(session()), () =>
    Promise.resolve(Buffer.alloc(0)),
  );
  const a = fakeSocket();
  const b = fakeSocket();
  const opened = await hub.open("s1");
  const unwatchA = opened?.watch(a);
  const unwatchB = opened?.watch(b);

  unwatchA?.();
  hub.release("s1");
  await Promise.resolve(); // let release()'s internal .then() settle
  expect(await hub.open("s1")).toBe(opened); // still shared: b is still watching

  unwatchB?.();
  hub.release("s1");
  await Promise.resolve();
  await Promise.resolve(); // release()'s .then() costs a tick before it deletes and closes

  const reopened = await hub.open("s1");
  expect(relay.openCount).toBe(2); // the old channel really closed; this is a fresh one
  expect(reopened).not.toBe(opened);
});
