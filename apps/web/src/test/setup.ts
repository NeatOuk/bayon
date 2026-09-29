import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom lays nothing out. Give the virtualizer what a browser would: rows (`data-index`) are
// ROW_PX tall, anything else is a VIEWPORT_PX viewport, a scroller's content is its first child,
// and scrollTo moves scrollTop at once and fires `scroll` afterwards, as a browser does (on its next
// frame, never inside the call). Fired inside the call, it reached the virtualizer mid-commit (its
// layout effect scrolls), and react-virtual's flushSync there logged "flushSync was called from
// inside a lifecycle method" on every screen with a timeline.
export const ROW_PX = 32;
export const VIEWPORT_PX = 640;

const scrollTops = new WeakMap<Element, number>();
const isRow = (el: HTMLElement) => el.dataset.index !== undefined;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return isRow(this) ? ROW_PX : VIEWPORT_PX;
    },
  },
  offsetWidth: { configurable: true, get: () => 800 },
  clientHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return isRow(this) ? ROW_PX : VIEWPORT_PX;
    },
  },
  scrollHeight: {
    configurable: true,
    get(this: HTMLElement) {
      const content = this.firstElementChild;
      return content instanceof HTMLElement
        ? Number.parseFloat(content.style.height) || 0
        : 0;
    },
  },
});

Object.defineProperty(Element.prototype, "scrollTop", {
  configurable: true,
  get(this: Element) {
    return scrollTops.get(this) ?? 0;
  },
  set(this: Element, top: number) {
    scrollTops.set(this, top);
  },
});

Object.defineProperty(Element.prototype, "scrollTo", {
  configurable: true,
  value(this: Element, options?: ScrollToOptions) {
    this.scrollTop = options?.top ?? this.scrollTop;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  },
});

// xterm.js (the Watch pane, on any screen that shows a live session) asks the window for
// media queries and observes its box; jsdom has neither. A browser's shape, answering "no match"
// and never firing — a test that cares stubs its own over these (terminal-tab.test.tsx).
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string): MediaQueryList => {
      const list = new EventTarget();
      return Object.assign(list, {
        matches: false,
        media,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
      });
    },
  });
}
if (typeof globalThis.ResizeObserver !== "function") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
}

// jsdom has no canvas: its getContext logs "not implemented" and gives nothing. xterm copes with
// nothing (it measures text another way), so give it that without the noise.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
