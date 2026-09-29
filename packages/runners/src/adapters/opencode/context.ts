// This runner's wire format for the context proxy (spec M12; the proxy is runner-neutral,
// model-proxy.ts): opencode's provider speaks OpenAI chat completions, so a tool result is a
// `role: "tool"` message naming its call by `tool_call_id`, and the call itself is in an earlier
// assistant message's `tool_calls`.
//
// A tool message qualifies when its call's function is one of COMPRESSIBLE_TOOLS and the call's
// arguments do not name the store of originals. OpenAI tool messages carry no error flag; the rules
// never drop an error line, so an error result loses nothing it needs. Content is a string or an
// array of parts: each text part is its own block, and every other part and field is kept as it was.
import { mentionsContextStore } from "@bayon/core";
import { z } from "zod";
import type { ContextTransform } from "../../context-rewrite.js";
import { COMPRESSIBLE_TOOLS } from "./tool-names.js";

/** Chat completions, relative to the provider's base URL (`…/v1` for Ollama's OpenAI API). */
export const COMPLETIONS_PATH = "/chat/completions";

const Body = z.looseObject({ messages: z.array(z.unknown()) });
const Call = z.looseObject({
  id: z.string().min(1),
  function: z.looseObject({
    name: z.string(),
    arguments: z.string().optional(),
  }),
});
const Assistant = z.looseObject({
  role: z.literal("assistant"),
  tool_calls: z.array(z.unknown()),
});
const Tool = z.looseObject({
  role: z.literal("tool"),
  tool_call_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.unknown())]),
});
const TextPart = z.looseObject({ type: z.literal("text"), text: z.string() });

type Obj = Readonly<Record<string, unknown>>;

/** Every tool call in the history, by id: whether its result may be compressed. */
function compressible(messages: readonly unknown[]): ReadonlySet<string> {
  return new Set(
    messages.flatMap((m) => {
      const msg = Assistant.safeParse(m);
      if (!msg.success) return [];
      return msg.data.tool_calls.flatMap((c) => {
        const call = Call.safeParse(c);
        return call.success &&
          COMPRESSIBLE_TOOLS.has(call.data.function.name) &&
          !mentionsContextStore(call.data.function.arguments ?? "")
          ? [call.data.id]
          : [];
      });
    }),
  );
}

/** A tool message's content with each text replaced; from the original, so key order is kept. */
function replaced(
  content: unknown,
  replace: (text: string) => string,
): unknown {
  if (typeof content === "string") return replace(content);
  return (content as readonly unknown[]).map((part) => {
    const text = TextPart.safeParse(part);
    return text.success
      ? { ...(part as Obj), text: replace(text.data.text) }
      : part;
  });
}

export const OPENCODE_CONTEXT: ContextTransform = {
  route(method, path) {
    if (method === "POST" && path === COMPLETIONS_PATH) return "compress";
    // The one other call an OpenAI-compatible provider makes; anything else is refused.
    return method === "GET" && path === "/models" ? "pass" : undefined;
  },

  mayHold: (raw) => raw.includes('"role":"tool"'),

  rewrite(body, replace) {
    const parsed = Body.safeParse(body);
    if (!parsed.success) return body;
    const ids = compressible(parsed.data.messages);
    const messages = (
      body as { readonly messages: readonly unknown[] }
    ).messages.map((m) => {
      const tool = Tool.safeParse(m);
      return tool.success && ids.has(tool.data.tool_call_id)
        ? { ...(m as Obj), content: replaced((m as Obj)["content"], replace) }
        : m;
    });
    return { ...(body as Obj), messages };
  },
};
