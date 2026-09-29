import { Readable } from "node:stream";
import {
  AgentSessionsQuery,
  TimelineExportQuery,
  TimelineQuery,
  type AgentSessionsPage,
  type TimelinePage,
} from "@bayon/proto";
import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import { unwrap } from "../errors.js";
import { HISTORY_SERVICE } from "../tokens.js";
import type { HistoryService } from "./history-service.js";

/** What the export needs of Express's response: to learn the client left, and to cut the body. */
interface ExportResponse {
  on(event: "close", listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

/**
 * A project's history: `GET /projects/:id/timeline` and its export. Read-only; mounted
 * beside ProjectsController on the same prefix, no route of which it shadows.
 */
@Controller("projects")
export class ProjectHistoryController {
  readonly #history: HistoryService;
  readonly #logger = new Logger("timeline-export");

  constructor(@Inject(HISTORY_SERVICE) history: HistoryService) {
    this.#history = history;
  }

  /** One page, newest first; an unknown project 404, a bad cursor or filter 400. */
  @Get(":id/timeline")
  async timeline(
    @Param("id") id: string,
    @Query({ schema: TimelineQuery }) query: TimelineQuery,
  ): Promise<TimelinePage> {
    return unwrap(await this.#history.timeline(id, query));
  }

  /**
   * Every row the filters match, as an attachment (JSONL or CSV), streamed: `pipe` stops reading
   * pages while the client is slow, and a client that leaves stops them for good. The first page is
   * read before any header goes out, so a 404 or 400 is still a status; a page that fails later cuts
   * the response (never a clean end, which would pass for a whole export).
   */
  @Get(":id/timeline/export")
  async export(
    @Param("id") id: string,
    @Query({ schema: TimelineExportQuery }) query: TimelineExportQuery,
    @Res({ passthrough: true }) res: ExportResponse,
  ): Promise<StreamableFile> {
    const started = unwrap(await this.#history.export(id, query));
    // Bytes, not objects: the stream buffers one page chunk ahead at most.
    const body = Readable.from(started.body, { objectMode: false });
    res.on("close", () => body.destroy());
    return new StreamableFile(body, {
      type: started.contentType,
      disposition: `attachment; filename="${started.filename}"`,
    }).setErrorHandler((error) => {
      this.#logger.error(`project ${id}: ${error.message}`);
      res.destroy(error);
    });
  }
}

/** `GET /agents/:id/sessions`: the agent's sessions for the replay list. */
@Controller("agents")
export class AgentSessionsController {
  readonly #history: HistoryService;

  constructor(@Inject(HISTORY_SERVICE) history: HistoryService) {
    this.#history = history;
  }

  /** Newest first; an unknown agent 404, a bad cursor 400. */
  @Get(":id/sessions")
  async sessions(
    @Param("id") id: string,
    @Query({ schema: AgentSessionsQuery }) query: AgentSessionsQuery,
  ): Promise<AgentSessionsPage> {
    return unwrap(await this.#history.agentSessions(id, query));
  }
}
