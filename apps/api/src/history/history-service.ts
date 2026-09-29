import { ok, type Clock, type Result } from "@bayon/core";
import {
  agentSessionsAfter,
  listAgentSessions,
  listTimeline,
  timelineAfter,
  type Db,
  type TimelineAfter,
  type TimelineQuery as DbTimelineQuery,
  type TimelineRow,
} from "@bayon/db";
import {
  AgentSessionsPage,
  TimelineEntry,
  TimelinePage,
  type AgentSessionsQuery,
  type TimelineExportQuery,
  type TimelineQuery,
} from "@bayon/proto";
import { z } from "zod";
import { jsonColumn, parseAs } from "../dto.js";
import {
  decodeSessionsCursor,
  decodeTimelineCursor,
  encodeSessionsCursor,
  encodeTimelineCursor,
} from "./history-cursor.js";
import { EXPORT_FORMATS } from "./timeline-format.js";

// A project's history: the timeline's pages, its export, and an agent's session list.
// Reads only, over @bayon/db. A class over {db, clock}, as ProjectsService is.

/** Rows per page an export reads: each page is its own short read snapshot, never one long read. */
export const EXPORT_PAGE_SIZE = 500;

export interface HistoryServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** Tests shrink it to put page boundaries inside a small export. */
  readonly exportPageSize?: number;
}

/** A started export: its headers, and its body, read a page at a time as the client takes it. */
export interface TimelineExport {
  readonly filename: string;
  readonly contentType: string;
  readonly body: AsyncIterable<string>;
}

type Filters = Omit<DbTimelineQuery, "workspaceId" | "after" | "limit">;

/** The filters both the page and the export take, in the db's words. */
const filtersOf = (q: TimelineExportQuery | TimelineQuery): Filters => ({
  ...(q.kind === undefined ? {} : { kinds: q.kind }),
  ...(q.agent === undefined ? {} : { agentId: q.agent }),
  ...(q.ticket === undefined ? {} : { ticket: q.ticket }),
  ...(q.from === undefined ? {} : { from: q.from }),
  ...(q.to === undefined ? {} : { to: q.to }),
  ...(q.q === undefined ? {} : { q: q.q }),
});

const Entries = z.array(TimelineEntry);

/** Stored rows into DTOs: the payload's JSON parsed; a row that does not fit is internal. */
function entriesOf(rows: readonly TimelineRow[]): Result<TimelineEntry[]> {
  const entries: unknown[] = [];
  for (const { payload_json, ...row } of rows) {
    const payload = jsonColumn(
      payload_json,
      `timeline ${row.source} ${row.key}`,
    );
    if (!payload.ok) return payload;
    entries.push(
      payload.value === null ? row : { ...row, payload: payload.value },
    );
  }
  return parseAs(Entries, entries, "timeline rows");
}

interface EntriesPage {
  readonly name: string;
  readonly entries: TimelineEntry[];
  readonly next: TimelineAfter | null;
}

/** A file-name-safe project name. */
const fileSafe = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "project";

export class HistoryService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #exportPageSize: number;

  constructor(deps: HistoryServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#exportPageSize = deps.exportPageSize ?? EXPORT_PAGE_SIZE;
  }

  /** One page, as DTOs, with where the next starts (null on the last). */
  async #page(
    projectId: string,
    filters: Filters,
    limit: number,
    after: TimelineAfter | undefined,
  ): Promise<Result<EntriesPage>> {
    const page = await listTimeline(this.#db, {
      workspaceId: projectId,
      limit,
      ...filters,
      ...(after === undefined ? {} : { after }),
    });
    if (!page.ok) return page;
    const entries = entriesOf(page.value.rows);
    if (!entries.ok) return entries;
    const last = page.value.rows.at(-1);
    return ok({
      name: page.value.workspace.name,
      entries: entries.value,
      next:
        page.value.hasMore && last !== undefined ? timelineAfter(last) : null,
    });
  }

  /** `GET /projects/:id/timeline`: one page, newest first. */
  async timeline(
    projectId: string,
    q: TimelineQuery,
  ): Promise<Result<TimelinePage>> {
    const after =
      q.cursor === undefined ? undefined : decodeTimelineCursor(q.cursor);
    if (after !== undefined && !after.ok) return after;
    const page = await this.#page(
      projectId,
      filtersOf(q),
      q.limit,
      after?.value,
    );
    if (!page.ok) return page;
    const { entries, next } = page.value;
    return parseAs(
      TimelinePage,
      {
        items: entries,
        next_cursor: next === null ? null : encodeTimelineCursor(next),
        has_more: next !== null,
      },
      `project ${projectId} timeline`,
    );
  }

  /**
   * `GET /projects/:id/timeline/export`: the first page is read here, so an unknown project or a bad
   * filter is still a status; the rest is read as the body is taken, a page per short snapshot. A
   * page that fails mid-body throws, and the controller cuts the response rather than end it.
   */
  async export(
    projectId: string,
    q: TimelineExportQuery,
  ): Promise<Result<TimelineExport>> {
    const filters = filtersOf(q);
    const first = await this.#page(
      projectId,
      filters,
      this.#exportPageSize,
      undefined,
    );
    if (!first.ok) return first;
    const format = EXPORT_FORMATS[q.format];
    const date = new Date(this.#clock.now()).toISOString().slice(0, 10);
    const pages = (after: TimelineAfter) =>
      this.#page(projectId, filters, this.#exportPageSize, after);
    return ok({
      filename: `${fileSafe(first.value.name)}-history-${date}.${q.format}`,
      contentType: format.contentType,
      body: exportBody(first.value, pages, format),
    });
  }

  /** `GET /agents/:id/sessions`: newest first; an unknown agent is 404. */
  async agentSessions(
    agentId: string,
    q: AgentSessionsQuery,
  ): Promise<Result<AgentSessionsPage>> {
    const after =
      q.cursor === undefined ? undefined : decodeSessionsCursor(q.cursor);
    if (after !== undefined && !after.ok) return after;
    const page = await listAgentSessions(this.#db, {
      agentId,
      limit: q.limit,
      ...(after === undefined ? {} : { after: after.value }),
    });
    if (!page.ok) return page;
    const last = page.value.rows.at(-1);
    const next =
      page.value.hasMore && last !== undefined
        ? encodeSessionsCursor(agentSessionsAfter(last))
        : null;
    return parseAs(
      AgentSessionsPage,
      { items: page.value.rows, next_cursor: next, has_more: next !== null },
      `agent ${agentId} sessions`,
    );
  }
}

/** The export's body: the header, then each page as one chunk, reading the next only when asked. */
async function* exportBody(
  first: EntriesPage,
  pages: (after: TimelineAfter) => Promise<Result<EntriesPage>>,
  format: (typeof EXPORT_FORMATS)[keyof typeof EXPORT_FORMATS],
): AsyncGenerator<string> {
  if (format.header !== "") yield format.header;
  let page = first;
  for (;;) {
    if (page.entries.length > 0) yield page.entries.map(format.row).join("");
    if (page.next === null) return;
    const next = await pages(page.next);
    if (!next.ok) {
      throw new Error(`timeline export stopped: ${next.error.class}`, {
        cause: next.error,
      });
    }
    page = next.value;
  }
}
