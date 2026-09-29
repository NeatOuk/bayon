import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FakeClock,
  hashToolset,
  ok,
  parseTruncationMarker,
  sha256Hex,
  systemClock,
} from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  listAudit,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ROLE_MATRIX,
  toolDefinitions,
  toolsetFor,
  type McpRole,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { DocsReader } from "../docs/reader.js";
import {
  FIXTURE_DOCS_SITE,
  startDocsFixture,
  type DocsFixture,
} from "../docs/fixtures.js";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { mcpDbStore } from "./db-store.js";

// doc_search and doc_get over /mcp: served to a work role, refused for a project with
// no source and for a page outside the project's spaces, each read that lands recorded as an audit
// row, and capped by §8.5's backstop with the whole page kept on disk.
//
// The site it reads is a local fixture; no test reaches a real one, and the token is a fake.

const OPERATOR = "e2e-docs-operator-token-0123456789";
const TOKENS = {
  withDocs: "tok-d-0123456789abcdefghijklmnopq",
  noDocs: "tok-n-0123456789abcdefghijklmnopq",
  noProject: "tok-p-0123456789abcdefghijklmnopq",
} as const;
const HASH = "0".repeat(64);
const TOKEN_VALUE = "fake-atlassian-token-91ab3c";

const BUILDER_ALL = ROLE_MATRIX.builder.filter(
  (wire) => wire !== "gate_submit",
);

const CallResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type CallResult = z.infer<typeof CallResult>;

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;
let fx: DocsFixture;
let runtime = "";
const clients: Client[] = [];

const hashOf = async (role: string, allowlist: readonly string[]) => {
  const tools = toolsetFor(role, allowlist);
  if (!tools.ok) throw new Error(tools.error.message);
  return hashToolset(toolDefinitions(tools.value));
};

beforeAll(async () => {
  fx = await startDocsFixture();
  fx.pages.set("101", {
    id: "101",
    title: "Acceptance",
    space: "ONE",
    storage: "<p>the harness exits zero</p>",
  });
  fx.pages.set("202", { id: "202", title: "Elsewhere", space: "TWO" });
  fx.pages.set("303", {
    id: "303",
    title: "Long",
    space: "ONE",
    storage: `<p>${"word ".repeat(4_000)}</p>`,
  });

  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 3));
  runtime = realpathSync(mkdtempSync(join(tmpdir(), "frm-docs-e2e-")));

  const session = async (id: string, agent: string, token: string) => ({
    ...newSessionInput(),
    id,
    agent_id: agent,
    role: "builder",
    state: "idle" as const,
    mcp_token_hash: await sha256Hex(token),
    toolset_hash: await hashOf("builder", BUILDER_ALL),
    ticket_id: null,
    created_at: 0,
  });

  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        {
          id: "W-DOCS",
          name: "W-DOCS",
          kind: "single",
          docs_kind: "confluence",
          docs_url: FIXTURE_DOCS_SITE,
          docs_email: "op@acme.test",
          docs_spaces_json: '["ONE"]',
        },
        { id: "W-NONE", name: "W-NONE", kind: "single" },
      ],
      profiles: [
        {
          id: "P-B",
          name: "P-B",
          runner_id: SPINE_SEED.runnerId,
          model_tier: "standard",
          tool_allowlist_json: JSON.stringify(BUILDER_ALL),
          version: 1,
          hash: HASH,
          created_at: 0,
        },
      ],
      agents: [
        {
          id: "A-DOCS",
          name: "a-docs",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          profile_id: "P-B",
          workspace_id: "W-DOCS",
          created_at: 0,
        },
        {
          id: "A-NONE",
          name: "a-none",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          profile_id: "P-B",
          workspace_id: "W-NONE",
          created_at: 0,
        },
        {
          id: "A-FLEET",
          name: "a-fleet",
          kind: "builder",
          runner_id: SPINE_SEED.runnerId,
          executor_id: SPINE_SEED.executorId,
          profile_id: "P-B",
          created_at: 0,
        },
      ],
      sessions: [
        await session("S-DOCS", "A-DOCS", TOKENS.withDocs),
        await session("S-NONE", "A-NONE", TOKENS.noDocs),
        await session("S-FLEET", "A-FLEET", TOKENS.noProject),
      ],
    }),
  );

  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: OPERATOR, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    runtimeDir: runtime,
    logger: false,
    mcp: {
      store: mcpDbStore(apiDb),
      // Many calls from one session in seconds; the rate has its own test in mcp.e2e.test.ts.
      limits: { rateCalls: 10_000 },
      docs: new DocsReader({
        token: {
          kind: "keychain",
          keychain: { service: "foreman-0123456789ab", owner: false },
          secrets: { get: () => Promise.resolve(ok(TOKEN_VALUE)) },
        },
        fetch: fx.fetchVia(),
        timeoutMs: 5_000,
      }),
    },
  });
});

afterAll(async () => {
  for (const client of clients) await client.close();
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
  await fx?.close();
  if (runtime !== "") rmSync(runtime, { recursive: true, force: true });
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(api.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

const call = async (
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallResult> =>
  CallResult.parse(
    await (await connect(token)).callTool({ name, arguments: args }),
  );

const textOf = (r: CallResult) => r.content[0]?.text ?? "";
const dataOf = (r: CallResult) =>
  z.record(z.string(), z.unknown()).parse(JSON.parse(textOf(r)));

test("the doc tools are listed for a work role, and for no other role", async () => {
  const listed = (await (await connect(TOKENS.withDocs)).listTools()).tools.map(
    (t) => t.name,
  );
  expect(listed).toContain("doc_search");
  expect(listed).toContain("doc_get");
  for (const role of ["conformance"] satisfies McpRole[]) {
    expect(ROLE_MATRIX[role]).not.toContain("doc_search");
    expect(ROLE_MATRIX[role]).not.toContain("doc_get");
  }
});

test("doc_search returns the project's pages, and the call leaves an audit row", async () => {
  const found = await call(TOKENS.withDocs, "doc_search", {
    q: "harness",
  });
  expect(found.isError).not.toBe(true);
  expect(dataOf(found)).toEqual({
    rows: [
      {
        id: "101",
        title: "Acceptance",
        space: "ONE",
        url: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
        excerpt: "Acceptance …",
      },
      {
        id: "303",
        title: "Long",
        space: "ONE",
        url: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/303/Long`,
        excerpt: "Long …",
      },
    ],
  });
  expect(
    unwrap(await listAudit(spine.db)).filter(
      (a) => a.action === "mcp.doc_search",
    ),
  ).toContainEqual(
    expect.objectContaining({
      actor: "session:S-DOCS",
      action: "mcp.doc_search",
    }),
  );
});

test("doc_get reads one page as Markdown, by id and by its link", async () => {
  const byId = await call(TOKENS.withDocs, "doc_get", { ref: "101" });
  expect(dataOf(byId)).toEqual({
    id: "101",
    title: "Acceptance",
    space: "ONE",
    url: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
    markdown: "the harness exits zero",
  });
  const byLink = await call(TOKENS.withDocs, "doc_get", {
    ref: `${FIXTURE_DOCS_SITE}/wiki/spaces/ONE/pages/101/Acceptance`,
  });
  expect(dataOf(byLink)).toMatchObject({ id: "101" });
});

// A page id is guessable, so "outside your spaces" and "no such page" must be byte-identical on
// the wire: same reason, same rule, same sentence, same kind of outcome (security review).
test("a page outside the project's spaces is indistinguishable from a page that is not there", async () => {
  const outside = await call(TOKENS.withDocs, "doc_get", { ref: "202" });
  const missing = await call(TOKENS.withDocs, "doc_get", { ref: "999" });
  expect(outside).toEqual(missing);
  expect(outside).toEqual({
    isError: true,
    content: [
      {
        type: "text",
        text: "refused: not_found (docs_page): that page is not available to this project",
      },
    ],
    structuredContent: {
      refused: true,
      reason: "not_found",
      rule: "docs_page",
      detail: "that page is not available to this project",
    },
  });
  expect(JSON.stringify(outside)).not.toContain("TWO");
  expect(JSON.stringify(outside)).not.toContain("ONE");
});

test("a project with no source, and a session with no project, are refused rather than failed", async () => {
  for (const token of [TOKENS.noDocs, TOKENS.noProject]) {
    for (const [name, args] of [
      ["doc_search", { q: "x" }],
      ["doc_get", { ref: "101" }],
    ] as const) {
      expect(await call(token, name, args), `${token} ${name}`).toMatchObject({
        isError: true,
        structuredContent: {
          refused: true,
          reason: "not_found",
          rule: "docs_source",
        },
      });
    }
  }
});

test("a page over the cap comes back truncated, with the whole of it kept on disk", async () => {
  const got = await call(TOKENS.withDocs, "doc_get", { ref: "303" });
  const text = textOf(got);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024);
  const marker = parseTruncationMarker(
    text.split("\n").find((l) => l.includes("truncated")) ?? "",
  );
  expect(marker).not.toBeNull();
  const path = marker?.path ?? "";
  expect(path.startsWith(join(runtime, "sessions", "S-DOCS"))).toBe(true);
  const whole = readFileSync(path, "utf8");
  expect(whole.length).toBeGreaterThan(text.length);
  expect(JSON.parse(whole)).toMatchObject({ id: "303", space: "ONE" });
});
