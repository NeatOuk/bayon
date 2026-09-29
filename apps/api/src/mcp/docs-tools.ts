import { DOC_SEARCH_MAX, MCP_INPUTS, MCP_PAGE_ROWS } from "@bayon/proto";
import { isDocsRefused, type DocsRefused } from "../docs/reader.js";
import {
  done,
  failed,
  refused,
  type Handler,
  type ToolCtx,
  type ToolOutcome,
} from "./tool-kit.js";

// `doc_search` and `doc_get`: the project's documentation, read-only, on the session's
// behalf.
//
// The project is the session's agent's workspace, from the token — no tool schema carries one, so a
// model cannot read another project's pages by asking (§11.1). A project with no source, and a
// session with no project, are **refused**, not failed: nothing is broken, there is simply nothing
// to read, and an agent that is told so can get on with the ticket.
//
// Page content is untrusted text on its way into a prompt. It is capped (the client trims the
// Markdown, §8.5's backstop then caps the whole result and keeps the rest on disk) and attributed
// (every call is an audit row). It is not sanitised: these tools are read-only, and every write an
// agent can make still goes through the audited, role-scoped, law-checked doors it already had.

/**
 * A reader refusal as a tool refusal: a closed reason, with the sentence the reader wrote.
 *
 * `unavailable` is one shape for two facts — a page outside the project's spaces, and a page the
 * site does not have. Its reason, rule and detail are fixed, so the two cannot be told apart on the
 * wire (docs/reader.ts says why that matters).
 */
function asRefusal(r: DocsRefused): ToolOutcome {
  if (r.refused === "unavailable") {
    return refused({
      reason: "not_found",
      rule: "docs_page",
      detail: r.detail,
    });
  }
  return r.refused === "no_source"
    ? refused({ reason: "not_found", rule: "docs_source", detail: r.detail })
    : refused({
        reason: "actor_not_allowed",
        rule: "docs_spaces",
        detail: r.detail,
      });
}

/** The project's source, or the refusal that stands in its place. */
async function sourceOf(ctx: ToolCtx) {
  const project = ctx.session.workspaceId;
  if (project === null) {
    return {
      outcome: refused({
        reason: "not_found",
        rule: "docs_source",
        detail:
          "this session belongs to no project, so it has no documentation source",
      }),
    };
  }
  const source = await ctx.store.docsSource(project);
  if (!source.ok) return { outcome: failed(source.error) };
  return { project, source: source.value };
}

/**
 * What a read left behind: one audit row naming the session, the tool and what it reached. Read
 * tools are not audited by the server (only refused writes are), and these are read tools — but
 * their result is untrusted text on its way into a prompt, so a run that went strange must have a
 * record of which page it read and when.
 */
async function record(
  ctx: ToolCtx,
  targetKind: string,
  targetId: string,
): Promise<ToolOutcome | null> {
  const logged = await ctx.store.audit(ctx.audit(targetKind, targetId));
  return logged.ok
    ? null
    : failed({
        class: "internal",
        message: "the documentation read could not be recorded",
        retryable: false,
      });
}

const docSearch: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.doc_search.parse(raw);
  if (ctx.docs === undefined) {
    return failed({
      class: "internal",
      message: "no documentation reader is configured",
      retryable: false,
    });
  }
  const found = await sourceOf(ctx);
  if (found.source === undefined) return found.outcome;
  const rows = await ctx.docs.search(found.source, {
    query: input.q,
    ...(input.space === undefined ? {} : { space: input.space }),
    limit: Math.min(input.limit ?? MCP_PAGE_ROWS, DOC_SEARCH_MAX),
  });
  if (!rows.ok) return failed(rows.error);
  if (isDocsRefused(rows.value)) return asRefusal(rows.value);
  const recorded = await record(ctx, "project", found.project);
  if (recorded !== null) return recorded;
  return done({
    rows: rows.value.map((hit) => ({
      id: hit.id,
      title: hit.title,
      space: hit.space,
      url: hit.url,
      excerpt: hit.excerpt,
    })),
  });
};

const docGet: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.doc_get.parse(raw);
  if (ctx.docs === undefined) {
    return failed({
      class: "internal",
      message: "no documentation reader is configured",
      retryable: false,
    });
  }
  const found = await sourceOf(ctx);
  if (found.source === undefined) return found.outcome;
  const page = await ctx.docs.get(found.source, input.ref);
  if (!page.ok) return failed(page.error);
  if (isDocsRefused(page.value)) return asRefusal(page.value);
  const { id, title, space, url, markdown } = page.value;
  const recorded = await record(ctx, "doc", `${space}/${id}`);
  if (recorded !== null) return recorded;
  return done({ id, title, space, url, markdown });
};

export const DOCS_HANDLERS = {
  doc_search: docSearch,
  doc_get: docGet,
} as const;
