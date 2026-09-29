// The body rewriter's memo (spec M12): bounded, least recently seen out, and a
// block of the live history (re-sent on every call) keeps its treatment however many others pass.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import {
  createBodyRewriter,
  type ContextTransform,
} from "./context-rewrite.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-rewrite-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOY: ContextTransform = {
  route: () => "compress",
  mayHold: () => true,
  rewrite(body, replace) {
    const b = body as { readonly blocks: readonly string[] };
    return { blocks: b.blocks.map((t) => replace(t)) };
  },
};
const big = (tag: string) =>
  Array.from({ length: 400 }, (_, i) => `${tag} line ${i} ok`).join("\n");
const body = (...texts: string[]) =>
  Buffer.from(JSON.stringify({ blocks: texts }));

test("a live block keeps its treatment, a failure included, while the memo turns over", async () => {
  const storeDir = join(root, CONTEXT_STORE_DIR);
  // `.foreman` is a file: the first store write fails, so the live block fails open.
  writeFileSync(join(root, ".foreman"), "");
  const rewriter = createBodyRewriter({
    transform: TOY,
    storeDir,
    memoEntries: 2,
  });
  const live = big("live");
  const first = await rewriter.rewrite(body(live), undefined);
  expect(first.counts).toMatchObject({ compressed: 0, failed: 1 });
  rmSync(join(root, ".foreman"));
  // Five more calls, each with a new block beside the live one: past the bound every time.
  for (let k = 0; k < 5; k += 1) {
    const out = await rewriter.rewrite(body(live, big(`new${k}`)), undefined);
    expect(out.counts).toMatchObject({ blocks: 2, compressed: 1, failed: 1 });
  }
  // A block that dropped out of the history comes back the same: the rules are pure.
  const back = await rewriter.rewrite(body(big("new0")), undefined);
  expect(back.counts).toMatchObject({ compressed: 1, failed: 0 });
});

test("the memo is bounded: a block no call re-sends is forgotten, least recently seen first", async () => {
  const dir = join(root, "bounded");
  const storeDir = join(dir, CONTEXT_STORE_DIR);
  mkdirSync(dir);
  writeFileSync(join(dir, ".foreman"), "");
  const rewriter = createBodyRewriter({
    transform: TOY,
    storeDir,
    memoEntries: 2,
  });
  const dead = big("dead");
  expect((await rewriter.rewrite(body(dead), undefined)).counts.failed).toBe(1);
  rmSync(join(dir, ".foreman"));
  for (const tag of ["a", "b", "c"]) {
    await rewriter.rewrite(body(big(tag)), undefined);
  }
  // Remembered, it would still fail; forgotten, it is treated anew and the store now takes it.
  expect((await rewriter.rewrite(body(dead), undefined)).counts).toMatchObject({
    compressed: 1,
    failed: 0,
  });
});
