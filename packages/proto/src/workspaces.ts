import { z } from "zod";

// Workspaces (§4): `GET /workspaces` fills a picker in the New ticket dialog. The
// table is config an operator writes (`frm project add` / `frm config apply`); this is read-only.

export const WorkspaceView = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["single", "multi", "submodule"]),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

export const WorkspacesView = z.object({
  workspaces: z.array(WorkspaceView),
});
export type WorkspacesView = z.infer<typeof WorkspacesView>;
