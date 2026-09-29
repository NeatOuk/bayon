// Read side of the rows registration writes: runners, models and executors, by id.
import type { Db, R } from "../connection.js";
import { all, qb, read } from "../connection.js";
import type {
  ExecutorRow,
  ModelRow,
  RepoRow,
  RunnerRow,
  WorkspaceRow,
} from "../schema.js";

/** Every repo by name: where a `mirrors` shell probe runs (§10.2). */
export function listRepos(db: Db): R<RepoRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("repos").selectAll().orderBy("name").orderBy("id")),
  );
}

export function listRunners(db: Db): R<RunnerRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("runners").selectAll().orderBy("id")),
  );
}

/** Every model row, retired ones included (active = 0). */
export function listModels(db: Db): R<ModelRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("models").selectAll().orderBy("id")),
  );
}

export function listExecutors(db: Db): R<ExecutorRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("executors").selectAll().orderBy("id")),
  );
}

export function listWorkspaces(db: Db): R<WorkspaceRow[]> {
  return read(db, (ix) =>
    all(ix, qb.selectFrom("workspaces").selectAll().orderBy("name")),
  );
}
