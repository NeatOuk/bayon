import {
  ProjectCreated,
  ProjectsView,
  type CreateProjectRequest,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, postJson } from "@/api/http";

// The projects' REST: POST /projects from the New project screen, and GET /projects
// for the Projects screen. New project's runner and executor pickers reuse
// GET /runners and GET /executors (`runnersQuery`, `executorsQuery`).

export const PROJECTS_KEY = ["projects"] as const;

/** `GET /projects`: each project with its repos, agents and open tickets. */
export const projectsQuery = queryOptions({
  queryKey: PROJECTS_KEY,
  queryFn: ({ signal }) => getJson("/projects", ProjectsView, signal),
});

/** `POST /projects`: 201 with the new project's ids, or a 400/409 the screen shows inline. */
export const createProject = (
  request: CreateProjectRequest,
): Promise<ProjectCreated> => postJson("/projects", request, ProjectCreated);
