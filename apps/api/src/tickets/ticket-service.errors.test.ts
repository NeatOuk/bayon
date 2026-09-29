import { FakeClock, type Actor, type FrmError, type Result } from "@bayon/core";
import {
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { TicketService } from "./ticket-service.js";

// The TicketService's failures: they come back as typed errors, never as a wrong answer.

const clock = new FakeClock(1_700_000_000_000);
const OPERATOR: Actor = { kind: "operator" };

const failure = <T>(result: Result<T>): FrmError => {
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

/** A migrated temp DB with the spine and `rows`, and a service over it. */
async function world(rows: Parameters<typeof seedRows>[1]) {
  const t = unwrap(await tempDb(clock));
  unwrap(await seedSpine(t.db, 3));
  unwrap(await seedRows(t.db, rows));
  return {
    t,
    service: new TicketService({ db: t.db, clock, workRoot: null }),
  };
}

const broken = await world({
  tickets: [ticketRow(1)],
  settings: [
    { key: "complexity.rubric", value_json: '{"v":1}', updated_at: 0 },
  ],
});
const bogus = await world({ tickets: [ticketRow(1, { status: "bogus" })] });
const plain = await world({ tickets: [ticketRow(1)] });
afterAll(() => {
  for (const w of [broken, bogus, plain]) w.t.cleanup();
});

describe("an invalid settings row fails loudly (never a silent default)", () => {
  test("every call that reads settings is a validation error", async () => {
    const { service } = broken;
    const calls: readonly Promise<Result<unknown>>[] = [
      service.list({ limit: 10 }),
      service.get("1", OPERATOR),
      service.create({ title: "t", type: "chore" }, OPERATOR),
      service.update("1", 1, { title: "x" }, OPERATOR),
      service.transition("1", 1, { to: "prioritized" }, OPERATOR),
    ];
    for (const result of await Promise.all(calls)) {
      expect(failure(result)).toMatchObject({
        class: "validation",
        message: expect.stringContaining("complexity.rubric"),
      });
    }
  });
});

describe("a stored status outside §3.2 is an internal error", () => {
  test("on get and on transition", async () => {
    const { service } = bogus;
    expect(failure(await service.get("1", OPERATOR)).class).toBe("internal");
    expect(
      failure(await service.transition("1", 1, { to: "parked" }, OPERATOR))
        .class,
    ).toBe("internal");
  });
});

describe("unknown tickets and refs", () => {
  test("are not_found or validation errors, whatever the call", async () => {
    const { service } = plain;
    expect(
      failure(await service.events("99", { since: 0, limit: 10 })).class,
    ).toBe("not_found");
    expect(
      failure(await service.comment("99", { body_md: "x" }, OPERATOR)).class,
    ).toBe("not_found");
    expect(
      failure(
        await service.link(
          "99",
          { kind: "pr", url: "https://x.test" },
          OPERATOR,
        ),
      ).class,
    ).toBe("not_found");
    expect(
      failure(
        await service.link("1", { kind: "relates", target: "nope" }, OPERATOR),
      ).class,
    ).toBe("validation");
    expect(
      failure(
        await service.link("1", { kind: "relates", target: "99" }, OPERATOR),
      ).class,
    ).toBe("not_found");
    expect(
      failure(await service.update("99", 1, { title: "x" }, OPERATOR)).class,
    ).toBe("not_found");
    expect(
      failure(await service.transition("99", 1, { to: "parked" }, OPERATOR))
        .class,
    ).toBe("not_found");
  });

  test("an unknown complexity fact on update is a validation error", async () => {
    const { service } = plain;
    expect(
      failure(
        await service.update(
          "1",
          1,
          { complexity_facts: { vibes: true } },
          OPERATOR,
        ),
      ).class,
    ).toBe("validation");
  });
});
