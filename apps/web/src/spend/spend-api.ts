import { SpendReport, type SpendGroup } from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson } from "@/api/http";

/** Every spend report: the `spend` topic swaps their summaries by this prefix. */
export const SPEND_KEY = ["spend"] as const;

/**
 * One project's reports. Outside SPEND_KEY on purpose: the fleet's `spend` frames write
 * their summary into every report under it, which would put the fleet's figures on a project's.
 */
export const projectSpendKey = (project: string): readonly string[] => [
  "project-spend",
  project,
];

/**
 * `GET /spend?group=` (§8.9): the summary and one grouping's rows. With `project`, every figure is
 * that project's, its summary the IDE's headline.
 */
export const spendQuery = (group: SpendGroup, project?: string) =>
  queryOptions({
    queryKey:
      project === undefined
        ? [...SPEND_KEY, group]
        : [...projectSpendKey(project), group],
    queryFn: ({ signal }) =>
      getJson(
        project === undefined
          ? `/spend?group=${group}`
          : `/spend?${new URLSearchParams({ group, project }).toString()}`,
        SpendReport,
        signal,
      ),
  });
