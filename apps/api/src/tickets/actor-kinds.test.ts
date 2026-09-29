import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "@bayon/core";
import { describe, expect, test } from "vitest";
import { actorRef, actorSessionId } from "./law-facts.js";

// The supervisor is a law actor on six edges, each through its named supervisor writer: `block`,
// the circuit breaker's through blockTicket, and the machine steps a
// gate's decision settles, through advanceTicket. No API door ever produces it. The
// API's actors are the operator (REST) and sessions (MCP, as orchestrator or worker); what they
// record never names the supervisor, and no API source constructs a supervisor actor.

const API_ACTORS: readonly Actor[] = [
  { kind: "operator" },
  { kind: "orchestrator", sessionId: "S-orch" },
  { kind: "worker", sessionId: "S-work" },
];

describe("the API's actors", () => {
  test("actorRef records the operator or a session, never the supervisor", () => {
    expect(API_ACTORS.map((a) => actorRef(a, "why"))).toEqual([
      { actor_kind: "operator", actor_id: "operator", reason: "why" },
      { actor_kind: "session", actor_id: "S-orch", reason: "why" },
      { actor_kind: "session", actor_id: "S-work", reason: "why" },
    ]);
  });

  test("actorSessionId is a session's id, or null for the operator", () => {
    expect(API_ACTORS.map(actorSessionId)).toEqual([null, "S-orch", "S-work"]);
  });

  test("no API source constructs a supervisor actor or records actor_kind supervisor", () => {
    const root = join(import.meta.dirname, "..");
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const path = join(dir, e.name);
        if (e.isDirectory()) return sources(path);
        return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
          ? [path]
          : [];
      });
    const files = sources(root);
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) =>
      /\b(?:actor_)?kind:\s*["']supervisor["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
