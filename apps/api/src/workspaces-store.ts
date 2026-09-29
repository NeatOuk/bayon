import { listWorkspaces, type Db, type WorkspaceRow } from "@bayon/db";
import { WorkspacesView, type WorkspaceView } from "@bayon/proto";
import { parseAs } from "./dto.js";
import type { ApiStore } from "./store.js";

// The workspaces half of the ApiStore: read-only, just enough to fill the New ticket
// dialog's picker. An operator writes the table (`frm project add` / `frm config apply`).

export type WorkspacesStore = Pick<ApiStore, "workspaces">;

const view = (w: WorkspaceRow): WorkspaceView => ({
  id: w.id,
  name: w.name,
  kind: w.kind,
});

export function workspacesStore(db: Db): WorkspacesStore {
  return {
    async workspaces() {
      const rows = await listWorkspaces(db);
      if (!rows.ok) return rows;
      return parseAs(
        WorkspacesView,
        { workspaces: rows.value.map(view) },
        "workspaces",
      );
    },
  };
}
