import { describe, expect, test, vi } from "vitest";
import { SlotCounter, tryAcquireAll } from "./slots.js";

describe("SlotCounter", () => {
  test("hands out slots up to capacity, then none until one is released", () => {
    const slots = new SlotCounter(2);
    const first = slots.tryAcquire();
    expect(slots.tryAcquire()).not.toBeNull();
    expect(slots.tryAcquire()).toBeNull();
    expect(slots.capacity()).toEqual({ slots: 2, used: 2 });

    first?.release();
    expect(slots.capacity()).toEqual({ slots: 2, used: 1 });
    expect(slots.tryAcquire()).not.toBeNull();
  });

  test("release is idempotent", () => {
    const slots = new SlotCounter(2);
    const slot = slots.tryAcquire();
    slot?.release();
    slot?.release();
    expect(slots.capacity()).toEqual({ slots: 2, used: 0 });
  });

  test("0 slots drains the executor: nothing is handed out", () => {
    expect(new SlotCounter(0).tryAcquire()).toBeNull();
  });

  test("resize up admits more at once; resize down preempts nothing", () => {
    const slots = new SlotCounter(1);
    const a = slots.tryAcquire();
    expect(slots.tryAcquire()).toBeNull();
    slots.resize(3);
    const b = slots.tryAcquire();
    expect(slots.capacity()).toEqual({ slots: 3, used: 2 });

    slots.resize(1);
    expect(slots.capacity()).toEqual({ slots: 1, used: 2 });
    expect(slots.tryAcquire()).toBeNull();
    a?.release();
    expect(slots.tryAcquire()).toBeNull();
    b?.release();
    expect(slots.tryAcquire()).not.toBeNull();
  });

  test("onRelease fires once per release, never for a repeated one, until unsubscribed", () => {
    const slots = new SlotCounter(2);
    const heard = vi.fn();
    const off = slots.onRelease(heard);
    const a = slots.tryAcquire();
    const [b] = slots.restore(1);
    a?.release();
    a?.release();
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    b?.release();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  test("restore(n) adopts n running processes, even past capacity", () => {
    const slots = new SlotCounter(2);
    const adopted = slots.restore(3);
    expect(adopted).toHaveLength(3);
    expect(slots.capacity()).toEqual({ slots: 2, used: 3 });

    adopted[0]?.release();
    expect(slots.tryAcquire()).toBeNull();
    adopted[1]?.release();
    expect(slots.tryAcquire()).not.toBeNull();
    expect(slots.capacity()).toEqual({ slots: 2, used: 2 });
  });

  test.each([-1, 1.5, Number.NaN])("refuses a count of %s", (count) => {
    const validation = expect.objectContaining({ class: "validation" });
    expect(() => new SlotCounter(count)).toThrow(validation);
    expect(() => new SlotCounter(1).restore(count)).toThrow(validation);
    expect(() => new SlotCounter(1).resize(count)).toThrow(validation);
  });
});

describe("tryAcquireAll", () => {
  test("takes every slot it asks for, and releases them all at once", () => {
    const slots = new SlotCounter(3);
    const claim = tryAcquireAll(slots, 2);
    expect(claim).not.toBeNull();
    expect(slots.capacity()).toEqual({ slots: 3, used: 2 });

    claim?.release();
    expect(slots.capacity()).toEqual({ slots: 3, used: 0 });
  });

  test("refuses all-or-nothing, leaving the counter exactly as it found it", () => {
    const slots = new SlotCounter(3);
    const held = slots.tryAcquire();
    expect(slots.capacity()).toEqual({ slots: 3, used: 1 });

    // Two free, three wanted: the partial take must not strand the two it managed to get.
    expect(tryAcquireAll(slots, 3)).toBeNull();
    expect(slots.capacity()).toEqual({ slots: 3, used: 1 });

    held?.release();
    expect(tryAcquireAll(slots, 3)).not.toBeNull();
  });

  test("releasing twice frees nothing extra, as one slot's release does", () => {
    const slots = new SlotCounter(2);
    const claim = tryAcquireAll(slots, 2);
    claim?.release();
    claim?.release();
    expect(slots.capacity()).toEqual({ slots: 2, used: 0 });
  });

  test("a claim of zero takes nothing and still releases cleanly", () => {
    const slots = new SlotCounter(1);
    const claim = tryAcquireAll(slots, 0);
    expect(claim).not.toBeNull();
    expect(slots.capacity()).toEqual({ slots: 1, used: 0 });
    claim?.release();
    expect(slots.tryAcquire()).not.toBeNull();
  });

  test.each([-1, 1.5, Number.NaN])("refuses a count of %s", (count) => {
    expect(() => tryAcquireAll(new SlotCounter(2), count)).toThrow(
      expect.objectContaining({ class: "validation" }),
    );
  });
});
