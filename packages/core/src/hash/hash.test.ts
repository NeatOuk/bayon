import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJson, type JsonValue } from "./canonical-json.js";
import {
  hashConfig,
  hashDoctrine,
  hashPrompt,
  hashToolset,
  sha256Hex,
  type DoctrineFile,
} from "./hashes.js";

const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const nodeSha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

// Built from code points so the source shows which is which.
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const E_ACUTE = String.fromCodePoint(0xe9);
const NUL = String.fromCodePoint(0);

describe("canonicalJson", () => {
  test("sorts keys at every depth, keeps array order, has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1,2]},"b":1}',
    );
  });

  test("drops undefined members, as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: true })).toBe('{"b":true}');
  });

  test("normalizes keys and strings to NFC", () => {
    const decomposed = `e${COMBINING_ACUTE}`;
    expect(decomposed).not.toBe(E_ACUTE);
    expect(canonicalJson({ [decomposed]: [decomposed] })).toBe(
      canonicalJson({ [E_ACUTE]: [E_ACUTE] }),
    );
  });

  test("serializes primitives exactly as JSON.stringify does", () => {
    expect(canonicalJson('say "hi"\n')).toBe('"say \\"hi\\"\\n"');
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(null)).toBe("null");
  });
});

describe("sha256Hex", () => {
  test("matches the standard test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(SHA256_ABC);
    expect(await sha256Hex("")).toBe(SHA256_EMPTY);
  });

  test("hashes the UTF-8 bytes of the text", async () => {
    for (const text of [E_ACUTE, "日本語", "🦀 crab", `a${NUL}b`]) {
      expect(await sha256Hex(text)).toBe(nodeSha256(text));
    }
  });
});

describe("hashPrompt", () => {
  test("is the sha256 of the exact prompt text", async () => {
    expect(await hashPrompt("abc")).toBe(SHA256_ABC);
  });

  test("whitespace and line endings are significant: the model sees them", async () => {
    const hash = await hashPrompt("a\nb");
    expect(await hashPrompt("a\r\nb")).not.toBe(hash);
    expect(await hashPrompt("a\nb ")).not.toBe(hash);
  });
});

describe("hashConfig", () => {
  test("is the sha256 of the canonical JSON", async () => {
    expect(await hashConfig({ b: [1], a: "x" })).toBe(
      nodeSha256('{"a":"x","b":[1]}'),
    );
  });

  test("is stable under key reordering at any depth", async () => {
    expect(await hashConfig({ a: 1, b: { c: 2, d: 3 } })).toBe(
      await hashConfig({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  test("ignores the formatting of the JSON it was read from", async () => {
    const pretty: JsonValue = JSON.parse(
      '{\n  "b": [1, 2],\n  "a": {"x": "y"}\n}',
    );
    const compact: JsonValue = JSON.parse('{"a":{"x":"y"},"b":[1,2]}');
    expect(await hashConfig(pretty)).toBe(await hashConfig(compact));
  });

  test("changes when a value or an array order changes", async () => {
    const hash = await hashConfig({ a: [1, 2] });
    expect(await hashConfig({ a: [2, 1] })).not.toBe(hash);
    expect(await hashConfig({ a: [1, 3] })).not.toBe(hash);
  });
});

describe("hashDoctrine", () => {
  const doctrine: DoctrineFile = {
    path: "DOCTRINE.md",
    content: "# rules\nbe kind\n",
  };
  const agents: DoctrineFile = { path: "docs/AGENTS.md", content: "agents\n" };

  test("is pinned: the rule is permanent once runs record it", async () => {
    // sha256 over sorted records `<utf8 length of path>:<path><sha256 of LF content>`.
    const record = (f: DoctrineFile) =>
      `${Buffer.byteLength(f.path)}:${f.path}${nodeSha256(f.content)}`;
    const expected = nodeSha256(
      [record(doctrine), record(agents)].sort().join(""),
    );
    expect(await hashDoctrine([doctrine, agents])).toBe(expected);
    expect(expected).toBe(
      "37f78e046e6169993bb17afdf8063d28be906d2696f27eb6beae22c6832e8268",
    );
    expect(await hashDoctrine([])).toBe(SHA256_EMPTY);
  });

  test("depends on the file set, not the order it was loaded in", async () => {
    expect(await hashDoctrine([doctrine, agents])).toBe(
      await hashDoctrine([agents, doctrine]),
    );
  });

  test("line endings do not matter (CRLF, CR, LF)", async () => {
    const hash = await hashDoctrine([doctrine]);
    for (const content of ["# rules\r\nbe kind\r\n", "# rules\rbe kind\r"]) {
      expect(await hashDoctrine([{ ...doctrine, content }])).toBe(hash);
    }
  });

  test("paths are compared in NFC", async () => {
    const content = "x";
    expect(await hashDoctrine([{ path: `caf${E_ACUTE}.md`, content }])).toBe(
      await hashDoctrine([{ path: `cafe${COMBINING_ACUTE}.md`, content }]),
    );
  });

  test("editing, renaming, adding or removing a file changes the hash", async () => {
    const hash = await hashDoctrine([doctrine, agents]);
    const variants: DoctrineFile[][] = [
      [{ ...doctrine, content: "# rules\nbe kinder\n" }, agents],
      [{ ...doctrine, path: "AGENTS.md" }, agents],
      [doctrine, agents, { path: "extra.md", content: "" }],
      [doctrine],
    ];
    for (const files of variants) {
      expect(await hashDoctrine(files)).not.toBe(hash);
    }
  });

  test("different file sets never collide", async () => {
    const sets: DoctrineFile[][] = [
      [],
      [{ path: "a", content: "" }],
      [{ path: "a", content: "bc" }],
      [{ path: "ab", content: "c" }],
      [{ path: "abc", content: "" }],
      [
        { path: "a", content: "b" },
        { path: "c", content: "" },
      ],
      [
        { path: "a", content: "x" },
        { path: "b", content: "y" },
      ],
      [
        { path: "a", content: "y" },
        { path: "b", content: "x" },
      ],
      [
        { path: "a", content: "x" },
        { path: "a", content: "x" },
      ],
      [{ path: "1:a", content: "" }],
      [{ path: "1", content: "" }],
    ];
    const hashes = await Promise.all(sets.map((files) => hashDoctrine(files)));
    expect(new Set(hashes).size).toBe(sets.length);
  });
});

describe("hashToolset", () => {
  const read = {
    name: "read",
    schema: { type: "object", properties: { path: { type: "string" } } },
  };
  const write = {
    name: "write",
    schema: {
      type: "object",
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
  };

  test("is pinned: the rule is permanent once runs record it", async () => {
    // sha256 over the canonical JSON array of [name, schema] pairs, sorted.
    const pair = (t: typeof read | typeof write) =>
      canonicalJson([t.name, t.schema]);
    const expected = nodeSha256(
      `[${[pair(write), pair(read)].sort().join(",")}]`,
    );
    expect(await hashToolset([write, read])).toBe(expected);
    expect(expected).toBe(
      "8858cc889d2b04ccbf497cdde6b9037da988f93b90ce1b66f0a86bc6193ea567",
    );
  });

  test("depends on the tool set, not its order", async () => {
    expect(await hashToolset([read, write])).toBe(
      await hashToolset([write, read]),
    );
  });

  test("schema key order does not matter", async () => {
    const reordered = {
      name: "read",
      schema: { properties: { path: { type: "string" } }, type: "object" },
    };
    expect(await hashToolset([reordered])).toBe(await hashToolset([read]));
  });

  test("a changed schema, a renamed tool or a new tool changes the hash", async () => {
    const hash = await hashToolset([read, write]);
    const variants = [
      [read, { ...write, schema: { ...write.schema, required: ["path"] } }],
      [{ ...read, name: "read_file" }, write],
      [read, write, { name: "delete", schema: {} }],
      [read],
    ];
    for (const tools of variants) {
      expect(await hashToolset(tools)).not.toBe(hash);
    }
  });
});
