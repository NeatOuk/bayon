import { describe, expect, test } from "vitest";
import type { RawRecord } from "./adapter.js";
import { createRecordQueue, splitLines } from "./records.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield bytes(part);
}

async function collect(source: AsyncIterable<RawRecord>) {
  const out: { text: string; partial: boolean }[] = [];
  for await (const r of source)
    out.push({ text: decoder.decode(r.bytes), partial: r.partial });
  return out;
}

describe("splitLines", () => {
  test("yields each line without its newline, across chunk boundaries", async () => {
    expect(
      await collect(splitLines(chunks('{"a":', "1}\n{", '"b":2}\n\n', "x\n"))),
    ).toEqual([
      { text: '{"a":1}', partial: false },
      { text: '{"b":2}', partial: false },
      { text: "", partial: false },
      { text: "x", partial: false },
    ]);
  });

  test("an EOF fragment is yielded partial", async () => {
    expect(await collect(splitLines(chunks("one\ntw", "o")))).toEqual([
      { text: "one", partial: false },
      { text: "two", partial: true },
    ]);
  });

  test("nothing in, nothing out", async () => {
    expect(await collect(splitLines(chunks()))).toEqual([]);
  });
});

describe("createRecordQueue", () => {
  const record = (text: string): RawRecord => ({
    bytes: bytes(text),
    partial: false,
  });

  test("delivers in order and ends after close, once drained", async () => {
    const queue = createRecordQueue(1024);
    await queue.push(record("a"));
    await queue.push(record("b"));
    queue.close();
    await queue.push(record("dropped after close"));
    expect(await collect(queue)).toEqual([
      { text: "a", partial: false },
      { text: "b", partial: false },
    ]);
  });

  test("a reader waiting on an empty queue wakes on push", async () => {
    const queue = createRecordQueue(1024);
    const reading = collect(queue);
    await queue.push(record("late"));
    queue.close();
    expect(await reading).toEqual([{ text: "late", partial: false }]);
  });

  test("push waits above the high-water mark until the reader drains", async () => {
    const queue = createRecordQueue(4);
    await queue.push(record("abc")); // 3 bytes: below the mark
    let released = false;
    const pushing = queue.push(record("defg")).then(() => {
      released = true;
    }); // 7 bytes buffered: waits
    await Promise.resolve();
    await Promise.resolve();
    expect(released).toBe(false);
    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next(); // takes "abc": 4 bytes left, at the mark
    await pushing;
    expect(released).toBe(true);
    queue.close();
    expect(await iterator.next()).toMatchObject({ done: false });
    expect(await iterator.next()).toMatchObject({ done: true });
  });

  test("it has one consumer", () => {
    const queue = createRecordQueue(1024);
    queue[Symbol.asyncIterator]();
    expect(() => queue[Symbol.asyncIterator]()).toThrow(
      expect.objectContaining({ class: "conflict" }),
    );
  });
});
