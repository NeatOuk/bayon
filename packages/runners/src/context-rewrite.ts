// One model call's request body through the context rules (spec M12, §8.5 / §8.3): the transform
// (an adapter's, which knows its provider's wire format) finds the eligible tool results; this
// decides each one's treatment, stores originals, and rebuilds the body. Runner-neutral.
//
// Fail open per block: any error sends the original bytes and counts the block `failed`. A block's
// treatment is memoised by its sha256 for the rewriter's (the session process's) lifetime, a failure
// included, so a re-sent history is treated the same way every time and serialises to the same
// bytes: the prompt-cache prefix holds. The memo is bounded (MEMO_ENTRIES, least recently seen
// first out). A block of the live history is seen on every call, so it is never the one evicted;
// and an evicted compressed or unchanged block would come back the same, the rules being pure.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  MAX_FRAME_DIGESTS,
  compressToolResult,
  needsCompression,
} from "@bayon/core";
import { storeOriginal } from "./context-store.js";

/**
 * How the proxy treats a route: `compress` rewrites the body and reports one frame, `quiet`
 * rewrites it without a frame (token counting sees what the model gets), `pass` streams it
 * untouched.
 */
export type ProxyRoute = "compress" | "quiet" | "pass";

/** A provider's wire format, as an adapter knows it (Invariant 1: none of that lives here). */
export interface ContextTransform {
  /** `path` is relative to the upstream base, without its query. Undefined: refused (404). */
  route(method: string, path: string): ProxyRoute | undefined;
  /**
   * Paths (relative to the upstream base) the runner sends a credential-free HEAD to, without the
   * session's bearer: a connection warm-up. The proxy answers such a HEAD itself, empty, and never
   * forwards it; any other method on the path still needs the bearer.
   */
  readonly probes?: readonly string[];
  /** A cheap look at the raw body: false when it can hold no tool result to compress. */
  mayHold(raw: string): boolean;
  /**
   * `body` with the text of each eligible tool result replaced by `replace(text)`, in body order,
   * as a new value (the input is never mutated). Key order is kept, so an unchanged block
   * serialises to the same bytes.
   */
  rewrite(body: unknown, replace: (text: string) => string): unknown;
}

/** One call's counts over its eligible blocks (core's ContextFrame, less type, ruleset and ms). */
export interface CallCounts {
  readonly blocks: number;
  readonly compressed: number;
  readonly failed: number;
  readonly chars_in: number;
  readonly chars_out: number;
  readonly digests: readonly string[];
}

/** Why a body went upstream untouched: logged by name, never with its content. */
export type Untouched =
  | "encoded"
  | "not_utf8"
  | "not_json"
  | "transform_failed"
  | "not_reproducible"
  | "oversize";

export interface Rewritten {
  /** The body to send; absent: the original bytes. */
  readonly body?: Buffer;
  readonly counts: CallCounts;
  readonly untouched?: Untouched;
}

type Treatment =
  | { readonly kind: "unchanged" }
  | { readonly kind: "compressed"; readonly text: string; readonly sha: string }
  | { readonly kind: "failed" };

const NONE: CallCounts = {
  blocks: 0,
  compressed: 0,
  failed: 0,
  chars_in: 0,
  chars_out: 0,
  digests: [],
};

/** A body the proxy could not read at all: one block, failed, so no fail-open is invisible. */
export const UNREADABLE: CallCounts = { ...NONE, blocks: 1, failed: 1 };

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

export interface BodyRewriter {
  rewrite(raw: Buffer, contentEncoding: string | undefined): Promise<Rewritten>;
}

/** The most block treatments a rewriter remembers. */
export const MEMO_ENTRIES = 4096;

export interface RewriterOptions {
  readonly transform: ContextTransform;
  /** Where originals go (outside every root the session writes); the marker names the file. */
  readonly storeDir: string;
  /** Tests only: the memo's bound. */
  readonly memoEntries?: number;
  /** A block that failed open, by a fixed reason; never its content. */
  readonly onFailure?: (reason: string) => void;
}

export function createBodyRewriter(o: RewriterOptions): BodyRewriter {
  // Insertion order is recency: a hit is moved to the end, the first key is the one to evict.
  const memo = new Map<string, Promise<Treatment>>();
  const bound = o.memoEntries ?? MEMO_ENTRIES;

  async function decide(text: string, sha: string): Promise<Treatment> {
    const name = `${sha}.txt`;
    try {
      const c = compressToolResult(text, {
        originalPath: join(o.storeDir, name),
      });
      if (c.kind === "unchanged") return { kind: "unchanged" };
      const stored = await storeOriginal(o.storeDir, name, text);
      if (!stored.ok) {
        o.onFailure?.(stored.error.message);
        return { kind: "failed" };
      }
      return { kind: "compressed", text: c.text, sha };
    } catch {
      o.onFailure?.("the rules failed");
      return { kind: "failed" };
    }
  }

  function treat(text: string): Promise<Treatment> {
    if (!needsCompression(text)) return Promise.resolve({ kind: "unchanged" });
    const sha = sha256(text);
    const known = memo.get(sha);
    if (known !== undefined) {
      memo.delete(sha);
      memo.set(sha, known);
      return known;
    }
    const made = decide(text, sha);
    memo.set(sha, made);
    if (memo.size > bound) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    return made;
  }

  /** A readable body left untouched: every block over the cap counts as failed. */
  const untouched = (texts: readonly string[], why: Untouched): Rewritten => {
    const chars = sum(texts.map((t) => t.length));
    return {
      counts: {
        ...NONE,
        blocks: texts.length,
        failed: texts.filter(needsCompression).length,
        chars_in: chars,
        chars_out: chars,
      },
      untouched: why,
    };
  };

  return {
    async rewrite(raw, contentEncoding) {
      const encoding = contentEncoding?.trim().toLowerCase();
      if (
        encoding !== undefined &&
        encoding !== "" &&
        encoding !== "identity"
      ) {
        return { counts: UNREADABLE, untouched: "encoded" };
      }
      let text: string;
      try {
        text = decoder.decode(raw);
      } catch {
        return { counts: UNREADABLE, untouched: "not_utf8" };
      }
      if (!o.transform.mayHold(text)) return { counts: NONE };
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { counts: UNREADABLE, untouched: "not_json" };
      }
      const texts: string[] = [];
      try {
        o.transform.rewrite(parsed, (t) => {
          texts.push(t);
          return t;
        });
      } catch {
        return { counts: UNREADABLE, untouched: "transform_failed" };
      }
      if (texts.length === 0) return { counts: NONE };
      // Only a body that re-serialises byte for byte is rewritten: anything else would change bytes
      // outside the blocks, and the cache prefix with them.
      if (JSON.stringify(parsed) !== text) {
        return untouched(texts, "not_reproducible");
      }
      const treatments = await Promise.all(texts.map(treat));
      const byText = new Map(texts.map((t, i) => [t, treatments[i]]));
      let body: unknown;
      try {
        body = o.transform.rewrite(parsed, (t) => {
          const d = byText.get(t);
          return d?.kind === "compressed" ? d.text : t;
        });
      } catch {
        return untouched(texts, "transform_failed");
      }
      const sent = treatments.map((d, i) =>
        d.kind === "compressed" ? d.text.length : (texts[i]?.length ?? 0),
      );
      const digests = treatments.flatMap((d) =>
        d.kind === "compressed" ? [d.sha] : [],
      );
      return {
        // Nothing compressed: the original bytes, which re-serialise to the same anyway.
        ...(digests.length === 0
          ? {}
          : { body: Buffer.from(JSON.stringify(body), "utf8") }),
        counts: {
          blocks: texts.length,
          compressed: digests.length,
          failed: treatments.filter((d) => d.kind === "failed").length,
          chars_in: sum(texts.map((t) => t.length)),
          chars_out: sum(sent),
          digests: digests.slice(0, MAX_FRAME_DIGESTS),
        },
      };
    },
  };
}
