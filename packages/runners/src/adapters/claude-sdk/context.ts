// This runner's wire format for the context proxy (spec M12; the proxy is runner-neutral,
// model-proxy.ts): which of the CLI's API calls carry history, and which blocks in a Messages API
// request body are tool results the rules may compress.
//
// A tool result qualifies when its `tool_use` (found by id in the same body's history) is one of
// COMPRESSIBLE_TOOLS, it is not an error result, and its input does not name the store of originals
// (an agent reading an original must see it whole). Diffs are left whole by the rules themselves.
// Content is a string or an array of blocks: each text element is its own block, and every other
// element (an image) and field (`cache_control`) is kept exactly as it was.
import { mentionsContextStore } from "@bayon/core";
import { z } from "zod";
import type { ContextTransform } from "../../context-rewrite.js";
import { TextBlock, ToolResultBlock, ToolUseBlock } from "./frames.js";
import { COMPRESSIBLE_TOOLS } from "./tool-names.js";

/** The Messages API path, relative to the base URL the CLI is given. */
export const MESSAGES_PATH = "/v1/messages";
export const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
/**
 * The CLI's preconnect (checked in 2.1.269 and 2.1.283): at init it sends `HEAD <base URL>/api/hello`
 * with a bare `fetch`, no credential and none of ANTHROPIC_CUSTOM_HEADERS, and ignores the answer.
 * It only warms a connection, which through the proxy is a loopback one; the proxy answers it.
 */
export const PRECONNECT_PATH = "/api/hello";

const Body = z.looseObject({ messages: z.array(z.unknown()) });
const Message = z.looseObject({
  role: z.string(),
  content: z.array(z.unknown()),
});

type Obj = Readonly<Record<string, unknown>>;

/** Every `tool_use` in the history, by id: its name and whether its input names the store. */
function toolUses(
  messages: readonly unknown[],
): ReadonlyMap<string, { readonly name: string; readonly store: boolean }> {
  return new Map(
    messages.flatMap((m) => {
      const msg = Message.safeParse(m);
      if (!msg.success) return [];
      return msg.data.content.flatMap((b) => {
        const use = ToolUseBlock.safeParse(b);
        return use.success
          ? [
              [
                use.data.id,
                {
                  name: use.data.name,
                  store: mentionsContextStore(
                    JSON.stringify(use.data.input ?? null),
                  ),
                },
              ] as const,
            ]
          : [];
      });
    }),
  );
}

/** A tool result's content with each text replaced; from the original, so key order is kept. */
function replaced(
  content: unknown,
  replace: (text: string) => string,
): unknown {
  if (typeof content === "string") return replace(content);
  if (!Array.isArray(content)) return content;
  return content.map((el: unknown) => {
    const text = TextBlock.safeParse(el);
    return text.success
      ? { ...(el as Obj), text: replace(text.data.text) }
      : el;
  });
}

export const CLAUDE_CONTEXT: ContextTransform = {
  probes: [PRECONNECT_PATH],

  route(method, path) {
    if (method === "POST" && path === MESSAGES_PATH) return "compress";
    if (method === "POST" && path === COUNT_TOKENS_PATH) return "quiet";
    // Anything else the CLI asks of its API goes through untouched; any other path is refused.
    return path.startsWith("/v1/") || path.startsWith("/api/")
      ? "pass"
      : undefined;
  },

  mayHold: (raw) => raw.includes('"tool_result"'),

  rewrite(body, replace) {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return body;
    const uses = toolUses(parsed.data.messages);
    const eligible = (block: unknown): boolean => {
      const result = ToolResultBlock.safeParse(block);
      if (!result.success || result.data.is_error === true) return false;
      const use = uses.get(result.data.tool_use_id);
      return (
        use !== undefined && !use.store && COMPRESSIBLE_TOOLS.has(use.name)
      );
    };
    const messages = (
      body as { readonly messages: readonly unknown[] }
    ).messages.map((m) => {
      const msg = Message.safeParse(m);
      if (!msg.success || msg.data.role !== "user") return m;
      const content = (
        m as { readonly content: readonly unknown[] }
      ).content.map((b) =>
        eligible(b)
          ? { ...(b as Obj), content: replaced((b as Obj)["content"], replace) }
          : b,
      );
      return { ...(m as Obj), content };
    });
    return { ...(body as Obj), messages };
  },
};
