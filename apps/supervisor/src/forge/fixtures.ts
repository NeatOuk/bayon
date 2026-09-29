import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { ForgeRemote } from "@bayon/core";
import type { Fetch } from "./http.js";

// A local stand-in for a forge's REST API, for tests only: no test ever reaches a real
// one. A `node:http` server on 127.0.0.1 answers the calls the client makes — list the open pull
// requests for a head, create one, read one by number, and page through a commit's
// check runs and statuses — from in-memory state, and records every request it saw
// with its headers, so a test can check where the token went and where it did not.
//
// `fetchVia` is the client's injected fetch: a request for `https://<api base>/…` goes to this
// server instead, unchanged. The client's own https check therefore still runs against an https URL.

/** The fixture's API base. `.test` is reserved (RFC 2606): it can never resolve anywhere. */
export const FIXTURE_API = "https://api.forge.test";
export const FIXTURE_HOST = "forge.test";

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface FixturePr {
  readonly number: number;
  readonly html_url: string;
  /** Which repository's `/pulls` it is on: two repos never share a list. */
  readonly path: string;
  readonly head: string;
  readonly base: string;
}

/** What one request gets instead of the normal answer. */
export type Override =
  | {
      readonly status: number;
      readonly body: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly redirect: string };

export interface ForgeFixture {
  readonly origin: string;
  readonly requests: SeenRequest[];
  /** The open pull requests, by `<owner>:<head>` as the forge's own query spells it. */
  readonly open: FixturePr[];
  /** Answers the next requests instead of the normal answer, one each, in order. */
  readonly overrides: Override[];
  /**
   * `GET …/pulls/{n}` answers, by request path (`/repos/<owner>/<repo>/pulls/<n>`): the
   * forge's own JSON body. A path with none is a 404, as the forge answers a request it cannot see.
   */
  readonly details: Map<string, unknown>;
  /**
   * A commit's check runs and statuses, by sha, as the forge's own JSON objects. Served
   * a page at a time by `per_page` and `page`, with `total_count`, for any repository's path.
   */
  readonly checkRuns: Map<string, unknown[]>;
  readonly statuses: Map<string, unknown[]>;
  /** The next created pull request's number. */
  next: number;
  fetchVia(apiBase?: string): Fetch;
  close(): Promise<void>;
}

/** The path `GET …/pulls/{n}` asks of this fixture, for `details`. */
export const pullPath = (
  n: number,
  owner = "an-owner",
  repo = "a-repo",
): string => `/repos/${owner}/${repo}/pulls/${n}`;

/** A pull request's body as the forge answers it: open, merged (by `by`) or closed unmerged. */
export function pullBody(
  n: number,
  state: "open" | "merged" | "closed",
  by = "a-reviewer",
): unknown {
  const merged = state === "merged";
  return {
    number: n,
    state: state === "open" ? "open" : "closed",
    merged,
    merged_at: merged ? "2026-09-01T10:00:00Z" : null,
    merged_by: merged ? { login: by, id: 7, type: "User" } : null,
    head: { sha: "0123456789abcdef0123456789abcdef01234567", ref: "frm/x" },
    html_url: `https://${FIXTURE_HOST}/pull/${n}`,
  };
}

/** A check run as the forge answers it. */
export const checkRun = (
  name: string,
  status: string,
  conclusion: string | null,
  html_url:
    string | null = `https://${FIXTURE_HOST}/runs/${encodeURIComponent(name)}`,
  o: { readonly id?: number; readonly started_at?: string | null } = {},
): unknown => ({
  id: o.id ?? 1,
  name,
  status,
  conclusion,
  started_at: o.started_at ?? null,
  html_url,
  details_url: null,
});

/** A commit status as the forge answers it. */
export const commitStatus = (
  context: string,
  state: string,
  target_url: string | null = null,
): unknown => ({ context, state, target_url, description: "" });

/** A remote pointing at this fixture: what a test hands the job as its `forgeRemoteOf`. */
export const fixtureRemote = (
  owner = "an-owner",
  repo = "a-repo",
): ForgeRemote => ({
  kind: "github",
  host: FIXTURE_HOST,
  owner,
  repo,
  apiBase: FIXTURE_API,
});

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => resolve(body));
  });

export async function startForgeFixture(): Promise<ForgeFixture> {
  const fixture: Omit<ForgeFixture, "origin" | "fetchVia" | "close"> = {
    requests: [],
    open: [],
    overrides: [],
    details: new Map(),
    checkRuns: new Map(),
    statuses: new Map(),
    next: 1,
  };
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://fixture");
        const body = await readBody(req);
        fixture.requests.push({
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          authorization: req.headers.authorization,
          body,
        });
        const override = fixture.overrides.shift();
        if (override !== undefined && "redirect" in override) {
          res.writeHead(302, { location: override.redirect }).end();
          return;
        }
        if (override !== undefined) {
          res
            .writeHead(override.status, {
              "content-type": "application/json",
              ...override.headers,
            })
            .end(override.body);
          return;
        }
        const commit = /\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(
          url.pathname,
        );
        if (commit !== null) {
          const [, sha = "", which] = commit;
          const all =
            (which === "check-runs" ? fixture.checkRuns : fixture.statuses).get(
              sha,
            ) ?? [];
          const per = Number(url.searchParams.get("per_page") ?? "30");
          const page = Number(url.searchParams.get("page") ?? "1");
          const items = all.slice((page - 1) * per, page * per);
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify(
              which === "check-runs"
                ? { total_count: all.length, check_runs: items }
                : {
                    state: "pending",
                    total_count: all.length,
                    statuses: items,
                  },
            ),
          );
          return;
        }
        if (/\/pulls\/\d+$/.test(url.pathname)) {
          const found = fixture.details.get(url.pathname);
          if (found === undefined) {
            res.writeHead(404).end('{"message":"Not Found"}');
            return;
          }
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(found));
          return;
        }
        if (!url.pathname.endsWith("/pulls")) {
          res.writeHead(404).end("{}");
          return;
        }
        if ((req.method ?? "GET") === "GET") {
          const head = url.searchParams.get("head") ?? "";
          const base = url.searchParams.get("base") ?? "";
          const found = fixture.open.filter(
            (pr) =>
              pr.path === url.pathname && pr.head === head && pr.base === base,
          );
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(found));
          return;
        }
        const asked = JSON.parse(body === "" ? "{}" : body) as {
          head?: string;
          base?: string;
        };
        const owner = url.pathname.split("/")[2] ?? "an-owner";
        const number = fixture.next;
        fixture.next += 1;
        const pr: FixturePr = {
          number,
          html_url: `https://${FIXTURE_HOST}/pull/${number}`,
          path: url.pathname,
          head: `${owner}:${asked.head ?? ""}`,
          base: asked.base ?? "",
        };
        fixture.open.push(pr);
        res
          .writeHead(201, { "content-type": "application/json" })
          .end(JSON.stringify({ number, html_url: pr.html_url }));
      })();
    },
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return Object.assign(fixture, {
    origin,
    fetchVia:
      (apiBase = FIXTURE_API): Fetch =>
      (url, init) =>
        url.startsWith(`${apiBase}/`)
          ? fetch(`${origin}${url.slice(apiBase.length)}`, init)
          : Promise.reject(new Error(`the fixture serves ${apiBase} only`)),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
