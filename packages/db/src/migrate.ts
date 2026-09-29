import { readdirSync, readFileSync } from "node:fs";
import { err, ok, sha256Hex, type Result } from "@bayon/core";
import { z } from "zod";
import { read, write, type Db, type Internals, type R } from "./connection.js";
import { capture, failure, toFrmError } from "./errors.js";

// Resolves to packages/db/migrations from src/ and from dist/ alike, so this file stays at src/.
const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const FILE_NAME = /^(\d{3})_([a-z0-9_]+)(\.down)?\.sql$/;
// Statements that manage the transaction or the connection, both of which the runner owns.
const FORBIDDEN =
  /(?:^|;)\s*(?:BEGIN|COMMIT|END\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA)\b/i;
const LEDGER = `CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
)`;

export interface MigrationRef {
  readonly version: number;
  readonly name: string;
}

export interface AppliedMigration extends MigrationRef {
  /** sha256 of the up file as applied. */
  readonly checksum: string;
  readonly appliedAt: number;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationRef[];
  /** Applied, but the file changed since (or is gone). up and down refuse while any exist. */
  readonly drifted: readonly MigrationRef[];
  readonly tables: readonly string[];
  readonly views: readonly string[];
}

interface Migration extends MigrationRef {
  readonly up: string;
  readonly down: string | undefined;
  readonly checksum: string;
}

export const migrationTag = (m: MigrationRef): string =>
  `${String(m.version).padStart(3, "0")}_${m.name}`;

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

interface Scanned {
  /** Only the normal-state text: never a comment's stray words or a literal's contents (e.g. a
   * `'--'` literal must not swallow the real statement after it; `'BEGIN'` as data must not be
   * mistaken for a `BEGIN` statement). */
  readonly safe: string;
  /** A `'…'` literal or a block comment that never closed: the caller must fail closed rather
   * than scan past whatever it hides. A `-- …` line comment needs no terminator: EOF ends it
   * exactly as a newline would, hiding nothing beyond the file itself. */
  readonly unterminated: boolean;
}

/**
 * Scans SQL text once, left to right, tracking exactly one of four states — normal, inside a
 * `'…'` string literal (`''` escapes included), inside a `-- …` line comment, or inside a block
 * comment — so a comment or literal marker found *inside* another of these is just data, never
 * mistaken for the start of a new one. Only normal-state text is kept.
 */
function scanSql(sql: string): Scanned {
  let safe = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // an escaped quote: still inside the literal
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) return { safe, unterminated: true };
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { safe, unterminated: true };
      i = end + 2;
      continue;
    }
    safe += c;
    i += 1;
  }
  return { safe, unterminated: false };
}

async function discover(dir: URL): Promise<Result<readonly Migration[]>> {
  const listed = capture(() =>
    readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .toSorted(),
  );
  if (!listed.ok)
    return invalid(`cannot read ${dir.pathname}: ${listed.error.message}`);
  const unknown = listed.value.filter((name) => !FILE_NAME.test(name));
  if (unknown.length > 0) {
    return invalid(
      `not NNN_name.sql or NNN_name.down.sql: ${unknown.join(", ")}`,
    );
  }
  const files = listed.value.map((file) => {
    const [, version = "", name = "", down] = FILE_NAME.exec(file) ?? [];
    return { file, version: Number(version), name, down: down !== undefined };
  });
  const ups = files.filter((f) => !f.down);
  if (ups.some((up, i) => up.version !== i + 1)) {
    const names = ups.map((f) => f.file).join(", ");
    return invalid(
      `versions must run 001, 002, … with no gaps or repeats: ${names}`,
    );
  }
  const orphans = files.filter(
    (f) =>
      f.down &&
      !ups.some((up) => up.version === f.version && up.name === f.name),
  );
  if (orphans.length > 0) {
    return invalid(
      `no up migration for ${orphans.map((f) => f.file).join(", ")}`,
    );
  }
  const texts = capture(
    () =>
      new Map(
        files.map((f) => [f.file, readFileSync(new URL(f.file, dir), "utf8")]),
      ),
  );
  if (!texts.ok) return texts;
  const text = (file: string) => texts.value.get(file) ?? "";
  const scanned = files.map((f) => ({ f, ...scanSql(text(f.file)) }));
  const unterminated = scanned.filter((s) => s.unterminated).map((s) => s.f);
  if (unterminated.length > 0) {
    return invalid(
      `${unterminated.map((f) => f.file).join(", ")}: unterminated string literal or block comment`,
    );
  }
  const managing = scanned
    .filter((s) => FORBIDDEN.test(s.safe))
    .map((s) => s.f);
  if (managing.length > 0) {
    const names = managing.map((f) => f.file).join(", ");
    return invalid(
      `${names}: BEGIN, COMMIT, ROLLBACK, SAVEPOINT and PRAGMA belong to the runner`,
    );
  }
  try {
    const migrations = await Promise.all(
      ups.map(async (up) => {
        const down = files.find((f) => f.down && f.version === up.version);
        return {
          version: up.version,
          name: up.name,
          up: text(up.file),
          down: down === undefined ? undefined : text(down.file),
          checksum: await sha256Hex(text(up.file)),
        };
      }),
    );
    return ok(migrations);
  } catch (thrown) {
    // Hashing an in-memory string should never fail, but a rejection must not escape.
    return err(toFrmError(thrown));
  }
}

const SchemaObjects = z.array(z.object({ type: z.string(), name: z.string() }));
const Ledger = z.array(
  z.object({
    version: z.int(),
    name: z.string(),
    checksum: z.string(),
    applied_at: z.int(),
  }),
);
type DbState = {
  objects: z.infer<typeof SchemaObjects>;
  ledger: z.infer<typeof Ledger>;
};

// An FTS5 table's shadow tables (tickets_fts_data, …) are part of it, so status leaves them out.
const SCHEMA_OBJECTS = `SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view')
  AND name NOT IN (SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'shadow')
  ORDER BY name`;

function readState(ix: Internals): DbState {
  const objects = SchemaObjects.parse(ix.raw.prepare(SCHEMA_OBJECTS).all());
  const ledger = objects.some((o) => o.name === "_migrations")
    ? Ledger.parse(
        ix.raw
          .prepare(
            "SELECT version, name, checksum, applied_at FROM _migrations ORDER BY version",
          )
          .all(),
      )
    : [];
  return { objects, ledger };
}

const ref = ({ version, name }: MigrationRef): MigrationRef => ({
  version,
  name,
});
const isBookkeeping = (table: string) =>
  table === "_migrations" || table.startsWith("sqlite_");

function summarize(
  files: readonly Migration[],
  state: DbState,
): MigrationStatus {
  const checksums = new Map(files.map((m) => [m.version, m.checksum]));
  const applied = new Set(state.ledger.map((row) => row.version));
  return {
    applied: state.ledger.map((row) => ({
      version: row.version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    })),
    pending: files.filter((m) => !applied.has(m.version)).map(ref),
    drifted: state.ledger
      .filter((row) => checksums.get(row.version) !== row.checksum)
      .map(ref),
    tables: state.objects
      .filter((o) => o.type === "table" && !isBookkeeping(o.name))
      .map((o) => o.name),
    views: state.objects.filter((o) => o.type === "view").map((o) => o.name),
  };
}

async function currentStatus(
  db: Db,
  files: readonly Migration[],
): R<MigrationStatus> {
  const state = await read(db, readState);
  return state.ok ? ok(summarize(files, state.value)) : state;
}

function refuseDrift(status: MigrationStatus): Result<void> {
  if (status.drifted.length === 0) return ok(undefined);
  return err(
    failure(
      "conflict",
      `applied migrations changed since: ${status.drifted.map(migrationTag).join(", ")}. ` +
        "Restore them; migrations are forward-only, so a change goes in a new file.",
    ),
  );
}

/** Runs one migration file inside the caller's transaction, then checks foreign keys. */
function runFile(ix: Internals, m: MigrationRef, sql: string): Result<void> {
  ix.raw.exec(sql);
  if (!ix.raw.inTransaction) {
    return invalid(
      `${migrationTag(m)} ended the runner's transaction (END or COMMIT)`,
    );
  }
  const violations = z
    .array(z.unknown())
    .parse(ix.raw.pragma("foreign_key_check"));
  if (violations.length > 0) {
    return err(
      failure(
        "validation",
        `${migrationTag(m)} leaves ${violations.length} foreign-key violation(s)`,
        violations,
      ),
    );
  }
  return ok(undefined);
}

export async function migrationStatus(
  db: Db,
  o: { dir?: URL } = {},
): R<MigrationStatus> {
  const files = await discover(o.dir ?? MIGRATIONS_DIR);
  return files.ok ? currentStatus(db, files.value) : files;
}

/**
 * Applies pending migrations up to `to` (default: all), each in its own IMMEDIATE transaction
 * that also records it in _migrations. A second run applies nothing.
 */
export async function migrateUp(
  db: Db,
  o: { to?: number; dir?: URL } = {},
): R<MigrationStatus> {
  const files = await discover(o.dir ?? MIGRATIONS_DIR);
  if (!files.ok) return files;
  const to = o.to ?? files.value.length;
  if (!Number.isInteger(to) || to < 0 || to > files.value.length) {
    return invalid(
      `to must be a version from 0 to ${files.value.length}, not ${to}`,
    );
  }
  const ledger = await write(db, (ix) => {
    ix.raw.exec(LEDGER);
    return ok(undefined);
  });
  if (!ledger.ok) return ledger;
  const before = await currentStatus(db, files.value);
  if (!before.ok) return before;
  const drift = refuseDrift(before.value);
  if (!drift.ok) return drift;
  const pending = new Set(before.value.pending.map((m) => m.version));
  for (const m of files.value.filter(
    (f) => f.version <= to && pending.has(f.version),
  )) {
    const applied = await write(db, (ix) => {
      const ran = runFile(ix, m, m.up);
      if (!ran.ok) return ran;
      ix.raw
        .prepare(
          "INSERT INTO _migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(m.version, m.name, m.checksum, ix.clock.now());
      return ok(undefined);
    });
    if (!applied.ok) return applied;
  }
  return currentStatus(db, files.value);
}

/** Reverts the highest applied migration, using its paired NNN_name.down.sql. */
export async function migrateDown(
  db: Db,
  o: { dir?: URL } = {},
): R<MigrationStatus> {
  const files = await discover(o.dir ?? MIGRATIONS_DIR);
  if (!files.ok) return files;
  const before = await currentStatus(db, files.value);
  if (!before.ok) return before;
  const drift = refuseDrift(before.value);
  if (!drift.ok) return drift;
  const last = before.value.applied.at(-1);
  if (last === undefined) return invalid("no migration is applied");
  const m = files.value.find((f) => f.version === last.version);
  const down = m?.down;
  if (down === undefined) {
    return invalid(
      `${migrationTag(last)} has no ${migrationTag(last)}.down.sql`,
    );
  }
  const reverted = await write(db, (ix) => {
    const ran = runFile(ix, last, down);
    if (!ran.ok) return ran;
    ix.raw
      .prepare("DELETE FROM _migrations WHERE version = ?")
      .run(last.version);
    return ok(undefined);
  });
  return reverted.ok ? currentStatus(db, files.value) : reverted;
}
