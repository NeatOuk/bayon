// JiraService's statuses against a temp-file DB and an in-memory Jira: the project's
// site answers its status names with the stored account and the host store's token; a missing
// token is a validation error naming how to store it, and nothing is sent.
import { FakeClock, JIRA_TOKEN_SECRET, err, ok } from "@bayon/core";
import { seedRows, tempDb, unwrap, type TempDb } from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import {
  PUSH_EMAIL,
  PUSH_SITE,
  PUSH_TOKEN,
  fakeJira,
} from "./push-fixtures.js";
import { JiraService } from "./service.js";
import type { JiraSync } from "./sync.js";
import type { JiraTokenStore } from "./token.js";

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const storeWith = (value: string | null): JiraTokenStore => ({
  kind: "keychain",
  keychain: { service: "foreman-0123456789ab", owner: false },
  secrets: {
    get: async (name) =>
      name === JIRA_TOKEN_SECRET && value !== null
        ? ok(value)
        : err({ class: "not_found", message: "none", retryable: false }),
  },
});

async function service(token: string | null) {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "P",
          name: "P",
          kind: "single",
          jira_url: PUSH_SITE,
          jira_email: PUSH_EMAIL,
          jira_jql: "project = ABC",
        },
      ],
    }),
  );
  const jira = fakeJira();
  jira.statuses.push("To Do", "In Progress", "Done");
  const svc = new JiraService({
    db: t.db,
    sync: {} as JiraSync,
    token: storeWith(token),
    fetch: jira.fetch,
  });
  return { svc, jira };
}

test("the site's statuses, sorted, asked with the project's account", async () => {
  const { svc, jira } = await service(PUSH_TOKEN);
  expect(await svc.statuses("P")).toEqual({
    ok: true,
    value: { statuses: ["Done", "In Progress", "To Do"] },
  });
  const basic = Buffer.from(`${PUSH_EMAIL}:${PUSH_TOKEN}`).toString("base64");
  expect(jira.seen.map((r) => r.authorization)).toEqual([
    `Basic ${basic}`,
    `Basic ${basic}`,
  ]);
});

test("no token: a validation error saying how to store it; nothing sent", async () => {
  const { svc, jira } = await service(null);
  const r = await svc.statuses("P");
  expect(r).toMatchObject({
    ok: false,
    error: {
      class: "validation",
      message: expect.stringContaining(JIRA_TOKEN_SECRET),
    },
  });
  expect(jira.seen).toEqual([]);
});
