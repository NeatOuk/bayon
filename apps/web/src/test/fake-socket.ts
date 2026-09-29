import type { ServerFrame, WebSocketLike } from "@bayon/proto";

type Listener = (event: { readonly data: unknown }) => void;

/**
 * A /ws socket the test drives by hand, for a real CursorClient: open it, push frames, drop it.
 * `sent` is every frame the client sent, parsed.
 */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: readonly unknown[] = [];
  #listeners: ReadonlyMap<string, readonly Listener[]> = new Map();

  send(data: string): void {
    this.sent = [...this.sent, JSON.parse(data)];
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, listener: Listener): void {
    const current = this.#listeners.get(type) ?? [];
    this.#listeners = new Map(this.#listeners).set(type, [
      ...current,
      listener,
    ]);
  }
  open(): void {
    this.readyState = 1;
    this.#emit("open", undefined);
  }
  receive(frame: ServerFrame): void {
    this.#emit("message", JSON.stringify(frame));
  }
  drop(): void {
    this.readyState = 3;
    this.#emit("close", undefined);
  }
  #emit(type: string, data: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}
