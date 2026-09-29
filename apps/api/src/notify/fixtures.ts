// A local stand-in for the notifier's HTTP destinations, for tests only: no test ever
// reaches a real ntfy server, webhook or Slack. A `node:http` server on 127.0.0.1 records every
// POST it gets (path, headers, body) and answers from a queue — a status, a redirect, or never — or
// 200 when the queue is empty. `fetchVia` is the channels' injected fetch: it sends a request for
// any `https://` URL to this server instead, path and init unchanged, so the https-only rule and
// `redirect: "error"` are exercised as in production.
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { err, ok } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import { z } from "zod";
import type { Fetch } from "./channels/channel.js";

export interface SeenPost {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export type HookAnswer =
  | {
      readonly status: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    }
  | { readonly hang: true };

export interface HookFixture {
  /** e.g. `http://127.0.0.1:53211`. */
  readonly origin: string;
  readonly seen: SeenPost[];
  /** Answers the next requests, one each, in order; 200 "ok" once empty. */
  readonly answers: HookAnswer[];
  /** Every `https://…` request to this server instead; anything else is refused, never sent. */
  fetchVia(): Fetch;
  close(): Promise<void>;
}

const Address = z.object({ port: z.int().positive() });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function startHookFixture(): Promise<HookFixture> {
  const hung: ServerResponse[] = [];
  const seen: SeenPost[] = [];
  const answers: HookAnswer[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "/",
        headers: req.headers,
        body,
      });
      const answer = answers.shift();
      if (answer !== undefined && "hang" in answer) {
        hung.push(res);
        return;
      }
      const a = answer ?? { status: 200, body: "ok" };
      res.writeHead(a.status, { ...a.headers }).end(a.body ?? "");
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = Address.parse(server.address());
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    seen,
    answers,
    fetchVia: () => (url, init) => {
      if (!url.startsWith("https://"))
        return Promise.reject(new Error("the fixture serves https URLs only"));
      const target = new URL(url);
      return fetch(`${origin}${target.pathname}${target.search}`, init);
    },
    close: async () => {
      for (const res of hung) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A host store holding exactly `values`: what the tests stand in for the Keychain with. */
export const fakeSecrets = (
  values: Readonly<Record<string, string>>,
): SecretStore => ({
  get: (name) => {
    const value = values[name];
    return Promise.resolve(
      value === undefined
        ? err({
            class: "validation",
            message: `secret ${name} is not in the secret store`,
            retryable: false,
          })
        : ok(value),
    );
  },
});
