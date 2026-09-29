import { err, newId, ok } from "@bayon/core";
import { sql } from "kysely";
import { z } from "zod";
import { requireText } from "../checks.js";
import {
  all,
  qb,
  read,
  returningOne,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { ftsQuery } from "../fts.js";
import type { KnowledgeRow } from "../schema-work.js";
import { audited, type AuditEntry } from "./audit.js";

// Shared memory (§11.2): the API appends proposals; knowledge_fts follows by trigger.

export interface NewKnowledge {
  readonly scope: string;
  readonly scope_ref?: string;
  readonly kind: string;
  readonly title: string;
  readonly body_md: string;
  readonly source_ticket_id?: string;
  readonly source_session_id?: string;
  readonly dedupe_key?: string;
}

/** Proposes a knowledge entry. Review and promotion are later writes. */
export async function appendKnowledge(
  db: Db,
  k: NewKnowledge,
  /** An MCP write's audit entry, committed with the entry. */
  audit?: AuditEntry,
): R<KnowledgeRow> {
  const checked = requireText({
    scope: k.scope,
    kind: k.kind,
    title: k.title,
    body_md: k.body_md,
  });
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const now = ix.clock.now();
    const entry = returningOne(
      ix,
      qb
        .insertInto("knowledge")
        .values({
          id: newId(now),
          scope: k.scope,
          scope_ref: k.scope_ref ?? null,
          kind: k.kind,
          title: k.title,
          body_md: k.body_md,
          source_ticket_id: k.source_ticket_id ?? null,
          source_session_id: k.source_session_id ?? null,
          status: "proposed",
          hits: 0,
          dedupe_key: k.dedupe_key ?? null,
          created_at: now,
        })
        .returningAll(),
    );
    return audited(ix, entry, audit);
  });
}

const KnowledgeSearchShape = z.object({
  /** Words that must all appear in the title or body. */
  q: z.string().trim().min(1),
  limit: z.int().min(1).max(100),
});
export type KnowledgeSearch = z.input<typeof KnowledgeSearchShape>;

/** Knowledge entries holding every word of `q`, best FTS5 rank first. */
export async function searchKnowledge(
  db: Db,
  s: KnowledgeSearch,
): R<KnowledgeRow[]> {
  const parsed = KnowledgeSearchShape.safeParse(s);
  if (!parsed.success) {
    return err(
      failure(
        "validation",
        `bad knowledge search: ${z.prettifyError(parsed.error)}`,
      ),
    );
  }
  const match = ftsQuery(parsed.data.q);
  if (match === null) return ok([]);
  return read(db, (ix) =>
    all(
      ix,
      qb
        .selectFrom("knowledge_fts")
        .innerJoin("knowledge", "knowledge.id", "knowledge_fts.ref")
        .selectAll("knowledge")
        .where(sql.ref("knowledge_fts"), "match", match)
        .orderBy(sql`knowledge_fts.rank`)
        .orderBy("knowledge.id")
        .limit(parsed.data.limit),
    ),
  );
}
