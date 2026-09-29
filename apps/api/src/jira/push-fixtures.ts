// An in-memory stand-in for a Jira Cloud site's write endpoints, for tests only: no
// test ever reaches a real Jira. Its `fetch` answers the issue's status, its transitions, a posted
// transition (204, which moves the issue) and a posted comment (201), `/myself` and `/status`, and
// records every request it saw — method, url, Authorization header and body — so a test can check
// what went where. `next` answers the next requests instead, one each, in order.
import type { Fetch } from "../atlassian/client.js";

export const PUSH_SITE = "https://example.atlassian.net";
export const PUSH_TOKEN = "fake-push-token-9d2e61c0ab";
export const PUSH_EMAIL = "someone@example.com";

export interface SeenPush {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

export type Canned =
  | { readonly status: number; readonly body?: string }
  | { readonly throws: Error };

export interface FakeJira {
  /** Each issue's current status name, by key. */
  readonly issues: Map<string, string>;
  /** The transitions each issue offers from where it is: id and target status name. */
  readonly transitions: Map<string, { id: string; to: string }[]>;
  readonly comments: Map<string, unknown[]>;
  readonly statuses: string[];
  readonly seen: SeenPush[];
  /** Answers the next requests instead, one each, in order. */
  readonly next: Canned[];
  readonly fetch: Fetch;
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function parsed(init: RequestInit): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : null;
}

export function fakeJira(): FakeJira {
  const fake: FakeJira = {
    issues: new Map(),
    transitions: new Map(),
    comments: new Map(),
    statuses: [],
    seen: [],
    next: [],
    fetch: (url, init) => {
      const headers = new Headers(init.headers);
      fake.seen.push({
        method: init.method ?? "GET",
        url,
        authorization: headers.get("authorization"),
        body: parsed(init),
      });
      const canned = fake.next.shift();
      if (canned !== undefined) {
        if ("throws" in canned) return Promise.reject(canned.throws);
        return Promise.resolve(
          new Response(canned.status === 204 ? null : (canned.body ?? ""), {
            status: canned.status,
          }),
        );
      }
      return Promise.resolve(answer(fake, url, init));
    },
  };
  return fake;
}

function answer(fake: FakeJira, url: string, init: RequestInit): Response {
  const u = new URL(url);
  if (u.origin !== PUSH_SITE) return new Response("", { status: 599 });
  if (u.pathname === "/rest/api/3/myself")
    return json(200, { accountId: "acc-1" });
  if (u.pathname === "/rest/api/3/status")
    return json(
      200,
      fake.statuses.map((name) => ({ name })),
    );
  const m = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(
    u.pathname,
  );
  const key = m?.[1] === undefined ? "" : decodeURIComponent(m[1]);
  const status = fake.issues.get(key);
  if (m === null || status === undefined)
    return json(404, { errorMessages: ["Issue does not exist"] });
  if (m[2] === undefined)
    return json(200, { fields: { status: { name: status } } });
  if (m[2] === "/comment" && init.method !== "POST")
    return json(200, {
      comments: [...(fake.comments.get(key) ?? [])].reverse(),
    });
  if (m[2] === "/comment") {
    fake.comments.set(key, [...(fake.comments.get(key) ?? []), parsed(init)]);
    return json(201, { id: "c1" });
  }
  const offered = fake.transitions.get(key) ?? [];
  if (init.method !== "POST")
    return json(200, {
      transitions: offered.map((t) => ({
        id: t.id,
        name: `to ${t.to}`,
        to: { name: t.to },
      })),
    });
  const body = parsed(init) as { transition?: { id?: string } } | null;
  const chosen = offered.find((t) => t.id === body?.transition?.id);
  if (chosen === undefined)
    return json(400, { errorMessages: ["bad transition"] });
  fake.issues.set(key, chosen.to);
  return new Response(null, { status: 204 });
}
