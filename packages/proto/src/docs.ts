import {
  DOCS_KINDS,
  DOCS_SPACES_MAX,
  DOCS_SPACE_KEY,
  JIRA_SITE,
  JIRA_SITE_MAX,
  normalizeJiraSite,
} from "@bayon/core";
import { z } from "zod";

// A project's documentation source, as `POST /projects`, `PATCH /projects/:id` and
// `GET /projects` carry it. No token: the reader uses the same host-store credential the Jira
// mirror does, read at call time and never stored (§14, Invariant 11).
//
// The site is held to the same origin the Jira source is, by core's own rule — the token is sent to
// it, and the value arrives over REST from any page on the LAN holding the operator's bearer. One
// rule, one place.

/** `workspaces.docs_kind`: no documentation source, or a Confluence Cloud one. */
export const DocsKind = z.enum(DOCS_KINDS);
export type DocsKind = z.infer<typeof DocsKind>;

/**
 * The documentation site, as the operator types it: trimmed, lowercased and stripped of one
 * trailing slash, then held to `https://<name>.atlassian.net` exactly. The same schema shape as
 * `JiraSiteUrl`, on the same core rule, because it is the same security control.
 */
export const DocsSiteUrl = z
  .string()
  .max(JIRA_SITE_MAX * 2)
  .transform(normalizeJiraSite)
  .pipe(
    z
      .string()
      .max(JIRA_SITE_MAX)
      .regex(
        JIRA_SITE,
        "an Atlassian Cloud site: https://<name>.atlassian.net",
      ),
  );

/** One space key an agent may read. */
export const DocsSpaceKey = z
  .string()
  .trim()
  .max(50)
  .regex(DOCS_SPACE_KEY, "a space key: letters, digits and _");

/**
 * `docs` on `POST /projects` and `PATCH /projects/:id`. `kind: "none"` turns the reader off.
 *
 * `url` and `email` are optional on purpose: absent, and with `kind: "confluence"`, the writer
 * takes the project's Jira source — the same site and the same account, which is what "same as
 * Jira" means in the GUI. A project with no Jira source and no site of its own is refused there,
 * naming the field; nothing is written.
 */
export const DocsSource = z
  .strictObject({
    kind: DocsKind,
    url: DocsSiteUrl.nullable().default(null),
    /** The Atlassian account the token belongs to. */
    email: z.email().max(254).nullable().default(null),
    /** The spaces an agent may read; empty is any the account can read. */
    spaces: z.array(DocsSpaceKey).max(DOCS_SPACES_MAX).default([]),
  })
  .refine(
    (docs) =>
      docs.kind !== "none" || (docs.url === null && docs.email === null),
    "a documentation source of `none` names no site or account",
  );
export type DocsSource = z.infer<typeof DocsSource>;

/** A stored source, as the views serve it. */
export const DocsSourceView = z.object({
  kind: DocsKind,
  url: z.string().nullable(),
  email: z.string().nullable(),
  spaces: z.array(z.string()),
});
export type DocsSourceView = z.infer<typeof DocsSourceView>;

/** The documentation source a project without one reads as. */
export const NO_DOCS: DocsSourceView = {
  kind: "none",
  url: null,
  email: null,
  spaces: [],
};
