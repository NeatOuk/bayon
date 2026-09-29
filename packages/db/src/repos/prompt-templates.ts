import { err, ok } from "@bayon/core";
import type { Insertable, Selectable } from "kysely";
import {
  execute,
  first,
  qb,
  read,
  write,
  type Db,
  type R,
} from "../connection.js";
import { failure, orNotFound } from "../errors.js";
import type { PromptTemplatesTable } from "../schema.js";

export type PromptTemplateRow = Selectable<PromptTemplatesTable>;
export type NewPromptTemplate = Omit<
  Insertable<PromptTemplatesTable>,
  "created_at"
>;

/**
 * Stores the code's prompt templates at supervisor boot (§8.2, M2 amendment). A stored template
 * never changes: an id already stored with the same hash is left as it is, and one stored with
 * another hash is a `conflict` (a template edited without a version bump) that writes nothing.
 */
export function upsertPromptTemplates(
  db: Db,
  templates: readonly NewPromptTemplate[],
): R<void> {
  return write(db, (ix) => {
    const now = ix.clock.now();
    for (const t of templates) {
      execute(
        ix,
        qb
          .insertInto("prompt_templates")
          .values({ ...t, created_at: now })
          .onConflict((oc) => oc.column("id").doNothing()),
      );
      const stored = first(
        ix,
        qb.selectFrom("prompt_templates").select("hash").where("id", "=", t.id),
      );
      if (stored?.hash !== t.hash) {
        return err(
          failure(
            "conflict",
            `prompt template ${t.id} is stored with another hash: bump its version`,
          ),
        );
      }
    }
    return ok(undefined);
  });
}

/** A stored template: what a run's `template_id` names. */
export async function getPromptTemplate(
  db: Db,
  id: string,
): R<PromptTemplateRow> {
  const found = await read(db, (ix) =>
    first(
      ix,
      qb.selectFrom("prompt_templates").selectAll().where("id", "=", id),
    ),
  );
  return orNotFound(found, `prompt template ${id}`);
}
