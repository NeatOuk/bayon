import { describe, expect, test } from "vitest";
import { emit, readGo, readOps, type ScriptIo } from "./io.js";

const encoder = new TextEncoder();

async function* chunks(
  ...lines: readonly string[]
): AsyncGenerator<Uint8Array> {
  for (const line of lines) yield encoder.encode(`${line}\n`);
}

describe("readOps", () => {
  test("parses one op per line, across chunk boundaries", async () => {
    async function* split(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('{"op":"se');
      yield encoder.encode(
        'nd","runId":"r1","text":"go"}\n{"op":"interrupt"}\n',
      );
    }
    const ops = [];
    for await (const op of readOps(split())) ops.push(op);
    expect(ops).toEqual([
      { op: "send", runId: "r1", text: "go" },
      { op: "interrupt" },
    ]);
  });

  test("skips a line that is not valid JSON or not a known op, never throwing", async () => {
    const ops = [];
    for await (const op of readOps(
      chunks(
        "not json",
        '{"op":"unknown"}',
        '{"op":"send","runId":"r1","text":"go"}',
      ),
    )) {
      ops.push(op);
    }
    expect(ops).toEqual([{ op: "send", runId: "r1", text: "go" }]);
  });

  test("a trailing line with no newline is dropped, not yielded partial", async () => {
    async function* partial(): AsyncGenerator<Uint8Array> {
      yield encoder.encode('{"op":"interrupt"}\n{"op":"send"');
    }
    const ops = [];
    for await (const op of readOps(partial())) ops.push(op);
    expect(ops).toEqual([{ op: "interrupt" }]);
  });
});

describe("readGo", () => {
  test("skips a leading interrupt and resolves on the first send", async () => {
    const ops = readOps(
      chunks('{"op":"interrupt"}', '{"op":"send","runId":"r1","text":"go"}'),
    );
    expect(await readGo(ops)).toEqual({ op: "send", runId: "r1", text: "go" });
  });

  test("resolves undefined when stdin ends before any send", async () => {
    const ops = readOps(chunks('{"op":"interrupt"}'));
    expect(await readGo(ops)).toBeUndefined();
  });
});

describe("emit", () => {
  test("writes one JSON line, no trailing whitespace beyond the newline", () => {
    const written: string[] = [];
    const io: ScriptIo = { stdout: { write: (chunk) => written.push(chunk) } };
    emit(io, { kind: "turn_start", runner_type: "t", payload: {} });
    expect(written).toEqual([
      '{"kind":"turn_start","runner_type":"t","payload":{}}\n',
    ]);
  });
});
