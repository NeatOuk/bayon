import type { DocsSourceFields } from "@bayon/core";
import type { DocsSourceView } from "@bayon/proto";

/**
 * A project's stored documentation source as the views serve it: the same fields, with
 * its space list copied — what the database repository returns is readonly, and what the wire
 * schema takes is not.
 */
export const docsView = (docs: DocsSourceFields): DocsSourceView => ({
  kind: docs.kind,
  url: docs.url,
  email: docs.email,
  spaces: [...docs.spaces],
});
