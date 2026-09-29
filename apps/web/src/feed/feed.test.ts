import { expect, test, vi } from "vitest";
import { createBrowserFeed } from "@/feed/feed";

/** Records the URL each WebSocket is opened with; never connects. */
function stubWebSocket(): readonly string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      readonly readyState = 0;
      constructor(url: string) {
        urls.push(url);
      }
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    },
  );
  return urls;
}

test.each([
  ["http:", "localhost:5173", "ws://localhost:5173/ws"],
  ["https:", "bayon.example", "wss://bayon.example/ws"],
])("a page on %s//%s opens %s", (protocol, host, url) => {
  const urls = stubWebSocket();
  const feed = createBrowserFeed({ protocol, host });
  feed.close();
  expect(urls).toEqual([url]);
});
