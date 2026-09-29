import {
  JiraStatuses,
  JiraSyncResult,
  JiraTokenStatus,
  ProjectJiraView,
  ProjectSettingsState,
  type JiraPushConfig,
  type JiraSource,
  type JiraSourceView,
} from "@bayon/proto";
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { ApiRequestError, getJson, patchJson, postJson } from "@/api/http";
import { TICKETS_KEY } from "@/api/queries";

// A project's Jira mirror's REST: `GET /jira` (the token's store and whether it is there),
// `GET /projects/:id/jira` (the source and the last sync), `POST /projects/:id/jira/sync`, and
// `PATCH /projects/:id {jira}` to set or clear the source. Each answer is parsed with proto's schema.

const segment = encodeURIComponent;

/** `GET /jira`: global, so the New project form can ask before the project exists. */
export const jiraTokenQuery = queryOptions({
  queryKey: ["jira-token"],
  queryFn: ({ signal }) => getJson("/jira", JiraTokenStatus, signal),
});

const PROJECT_JIRA_KEY = "project-jira";

/** `GET /projects/:id/jira`: its source (null: none) and its newest sync (null: never). */
export const projectJiraQuery = (project: string) =>
  queryOptions({
    queryKey: [PROJECT_JIRA_KEY, project],
    queryFn: ({ signal }) =>
      getJson(`/projects/${segment(project)}/jira`, ProjectJiraView, signal),
  });

/** `POST /projects/:id/jira/sync`: the counts, or the route's typed refusal. No body. */
export const syncProjectJira = (project: string): Promise<JiraSyncResult> =>
  postJson(`/projects/${segment(project)}/jira/sync`, {}, JiraSyncResult);

/** `PATCH /projects/:id {jira}`: a source to mirror, or null to stop. */
export const setProjectJira = (
  project: string,
  jira: JiraSource | null,
): Promise<ProjectSettingsState> =>
  patchJson(`/projects/${segment(project)}`, { jira }, ProjectSettingsState);

/** `PATCH /projects/:id {jira_push}`: the status each moment moves an issue to, and PR comments. */
export const setProjectJiraPush = (
  project: string,
  jira_push: JiraPushConfig,
): Promise<ProjectSettingsState> =>
  patchJson(
    `/projects/${segment(project)}`,
    { jira_push },
    ProjectSettingsState,
  );

/** `GET /projects/:id/jira/statuses`: the site's status names, asked for on the button only. */
export const fetchJiraStatuses = (project: string): Promise<JiraStatuses> =>
  getJson(`/projects/${segment(project)}/jira/statuses`, JiraStatuses);

/**
 * The 409 of a sync already running: retryable, unlike the 409 of a project with no source. Not a
 * failure: the running sync's result lands in `last_sync` when it ends.
 */
export const isSyncRunning = (error: unknown): boolean =>
  error instanceof ApiRequestError &&
  error.status === 409 &&
  error.error.retryable;

/**
 * A refusal the sync never reached, so no `last_sync` records it (an unknown project, no source):
 * its own message is the only account. A 400 or 5xx ran and was audited — the refetched `last_sync`
 * says why, in words a 5xx body hides.
 */
export function unrecordedRefusal(error: unknown): string | null {
  if (!(error instanceof ApiRequestError))
    return error instanceof Error ? error.message : null;
  if (isSyncRunning(error)) return null;
  return error.status === 404 || error.status === 409
    ? error.error.message
    : null;
}

/**
 * After a sync, run or refused: the strip's last sync, the board it may have filled, and the
 * token's status (a sync that reached Jira read the token the operator just stored).
 */
export const afterJiraSync = (
  queryClient: QueryClient,
  project: string,
): Promise<void> =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: [PROJECT_JIRA_KEY, project] }),
    queryClient.invalidateQueries({ queryKey: TICKETS_KEY }),
    queryClient.invalidateQueries({ queryKey: jiraTokenQuery.queryKey }),
  ]).then(() => undefined);

/**
 * After the source changed: the strip shows the server's source at once and refetches, and so does
 * the token's status (the operator may have stored it meanwhile).
 */
export async function afterJiraWrite(
  queryClient: QueryClient,
  project: string,
  source: JiraSourceView | null,
): Promise<void> {
  queryClient.setQueryData<ProjectJiraView>(
    projectJiraQuery(project).queryKey,
    (known) => (known === undefined ? undefined : { ...known, source }),
  );
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [PROJECT_JIRA_KEY, project] }),
    queryClient.invalidateQueries({ queryKey: jiraTokenQuery.queryKey }),
  ]);
}
