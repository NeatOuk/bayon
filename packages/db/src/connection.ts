import Database from "better-sqlite3";
import { err, ok, type Clock, type Result } from "@bayon/core";
import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
} from "kysely";
import { Rollback, capture, failure } from "./errors.js";
import { withBusyRetry } from "./retry.js";
import type { DB } from "./schema.js";

export type R<T> = Promise<Result<T>>;

/** A database handle. Opaque: SQL is reachable only through this package's functions (§9.5). */
export interface Db {
  readonly stats: Readonly<{ txns: number; busy: number }>;
  close(): R<void>;
}

export interface OpenOptions {
  readonly path: string;
  readonly clock: Clock;
  /** The busy-retry jitter source, in [0, 1). Tests pin it. */
  readonly random?: () => number;
}

/** What only this package sees of a Db. */
export interface Internals {
  readonly raw: Database.Database;
  readonly clock: Clock;
  readonly random: () => number;
  readonly statements: Map<string, Database.Statement<unknown[]>>;
  /** Committed write transactions, and busy retries (§13.2). */
  readonly stats: { txns: number; busy: number };
}

const internals = new WeakMap<Db, Internals>();

/**
 * Kysely only compiles; better-sqlite3 runs each statement synchronously. Kysely's own SQLite
 * driver is async and opens a deferred BEGIN, and in WAL a deferred read-to-write upgrade can
 * fail with SQLITE_BUSY_SNAPSHOT, which busy_timeout never waits on.
 */
export const qb = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

// §4: set on every open, then read back. [pragma, value set, value read back]
const PRAGMAS = [
  ["journal_mode", "WAL", "wal"],
  ["synchronous", "NORMAL", 1],
  ["busy_timeout", "5000", 5000],
  ["foreign_keys", "ON", 1],
  ["wal_autocheckpoint", "1000", 1000],
] as const;

function applyPragmas(raw: Database.Database): Result<void> {
  const readBack = capture(() => {
    for (const [name, value] of PRAGMAS) raw.pragma(`${name} = ${value}`);
    return PRAGMAS.flatMap(([name, , want]) => {
      const got = raw.pragma(name, { simple: true });
      return got === want ? [] : [`${name}=${String(got)} (want ${want})`];
    });
  });
  if (!readBack.ok) return readBack;
  return readBack.value.length === 0
    ? ok(undefined)
    : err(
        failure(
          "validation",
          `pragmas did not apply: ${readBack.value.join(", ")}. The database must be a local ` +
            "file: :memory: and network filesystems cannot run WAL (§4).",
        ),
      );
}

/** Wraps an already-pragma'd connection as an opaque `Db` (§9.5: SQL only through this package). */
function wrap(raw: Database.Database, o: OpenOptions): Db {
  const ix: Internals = {
    raw,
    clock: o.clock,
    random: o.random ?? Math.random,
    statements: new Map(),
    stats: { txns: 0, busy: 0 },
  };
  const db: Db = {
    get stats() {
      return { ...ix.stats };
    },
    close: async () =>
      capture(() => {
        raw.close();
      }),
  };
  internals.set(db, ix);
  return db;
}

/** Opens `path`, applies and verifies the §4 pragmas. One connection per process. */
export async function openDb(o: OpenOptions): R<Db> {
  const opened = capture(() => new Database(o.path));
  if (!opened.ok) {
    return err(
      failure("validation", `cannot open ${o.path}: ${opened.error.message}`),
    );
  }
  const raw = opened.value;
  const pragmas = applyPragmas(raw);
  if (!pragmas.ok) {
    raw.close();
    return pragmas;
  }
  return ok(wrap(raw, o));
}

// A read-only handle only sets what a reader needs: `busy_timeout` so a reader waits out a writer's
// transaction instead of failing at once. `journal_mode`/`synchronous`/`wal_autocheckpoint` are
// write-mode settings that mean nothing here (and `PRAGMA journal_mode=WAL` on a read-only
// connection is a no-op that would otherwise silently fail the readback check).
const READONLY_PRAGMAS = [["busy_timeout", "5000", 5000]] as const;

function applyReadOnlyPragmas(raw: Database.Database): Result<void> {
  const readBack = capture(() => {
    for (const [name, value] of READONLY_PRAGMAS)
      raw.pragma(`${name} = ${value}`);
    return READONLY_PRAGMAS.flatMap(([name, , want]) => {
      const got = raw.pragma(name, { simple: true });
      return got === want ? [] : [`${name}=${String(got)} (want ${want})`];
    });
  });
  if (!readBack.ok) return readBack;
  return readBack.value.length === 0
    ? ok(undefined)
    : err(
        failure(
          "validation",
          `pragmas did not apply: ${readBack.value.join(", ")}`,
        ),
      );
}

/**
 * Opens `path` read-only. `fileMustExist` makes a wrong path fail fast instead of silently creating
 * an empty database. Any write attempted through the returned handle throws at the SQLite layer
 * ("attempt to write a readonly database") -- a second enforcement layer, independent of code
 * review, for a process that must never touch the DB (a `script` runner job's child process,
 *, which reports what it did through a manifest file instead).
 */
export async function openDbReadOnly(o: OpenOptions): R<Db> {
  const opened = capture(
    () => new Database(o.path, { readonly: true, fileMustExist: true }),
  );
  if (!opened.ok) {
    return err(
      failure(
        "validation",
        `cannot open ${o.path} read-only: ${opened.error.message}`,
      ),
    );
  }
  const raw = opened.value;
  const pragmas = applyReadOnlyPragmas(raw);
  if (!pragmas.ok) {
    raw.close();
    return pragmas;
  }
  return ok(wrap(raw, o));
}

export function internalsOf(db: Db): Result<Internals> {
  const ix = internals.get(db);
  return ix === undefined
    ? err(failure("validation", "not a Db from openDb"))
    : ok(ix);
}

const retryContext = (ix: Internals) => ({
  clock: ix.clock,
  random: ix.random,
  onRetry: () => {
    ix.stats.busy += 1;
  },
});

/** A read: one statement (WAL gives it a consistent snapshot), with busy retries. */
export async function read<T>(db: Db, fn: (ix: Internals) => T): R<T> {
  const found = internalsOf(db);
  if (!found.ok) return found;
  const ix = found.value;
  return withBusyRetry(retryContext(ix), () => fn(ix));
}

/**
 * Several reads that must agree: `fn` inside one deferred (read) transaction, so every statement
 * sees the WAL snapshot its first one opened, whatever other connections commit meanwhile. Busy
 * retries go around the whole transaction.
 */
export async function readSnapshot<T>(db: Db, fn: (ix: Internals) => T): R<T> {
  const found = internalsOf(db);
  if (!found.ok) return found;
  const ix = found.value;
  return withBusyRetry(retryContext(ix), () =>
    ix.raw.transaction(() => fn(ix)).deferred(),
  );
}

/**
 * A write: `fn` inside one BEGIN IMMEDIATE transaction, with busy retries around the whole
 * transaction. An error result from `fn` rolls it back.
 */
export async function write<T>(db: Db, fn: (ix: Internals) => Result<T>): R<T> {
  const found = internalsOf(db);
  if (!found.ok) return found;
  const ix = found.value;
  return withBusyRetry(retryContext(ix), () => {
    const value = ix.raw
      .transaction(() => {
        const result = fn(ix);
        if (!result.ok) throw new Rollback(result.error);
        return result.value;
      })
      .immediate();
    ix.stats.txns += 1;
    return value;
  });
}

function prepare(ix: Internals, sql: string): Database.Statement<unknown[]> {
  const cached = ix.statements.get(sql);
  if (cached !== undefined) return cached;
  const statement = ix.raw.prepare<unknown[]>(sql);
  ix.statements.set(sql, statement);
  return statement;
}

/** Runs a query and returns its rows, typed by Kysely; schema.test.ts pins those types to the DDL. */
export function all<O>(ix: Internals, query: Compilable<O>): O[] {
  const { sql, parameters } = query.compile();
  return prepare(ix, sql).all(...parameters) as O[];
}

export const first = <O>(ix: Internals, query: Compilable<O>): O | undefined =>
  all(ix, query)[0];

/** Runs a statement that returns no rows. */
export function execute(ix: Internals, query: Compilable<unknown>): void {
  const { sql, parameters } = query.compile();
  prepare(ix, sql).run(...parameters);
}

/** Runs an INSERT/UPDATE … RETURNING that must return exactly one row. */
export function returningOne<O>(
  ix: Internals,
  query: Compilable<O>,
): Result<O> {
  const row = first(ix, query);
  return row === undefined
    ? err(failure("internal", "the statement returned no row"))
    : ok(row);
}
