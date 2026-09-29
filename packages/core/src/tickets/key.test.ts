import { expect, test } from "vitest";
import { ticketKey, ticketRefOf } from "./key.js";

// The ticket forms prompts show: the key, #n and n name a number; the rest is an id.

test("the key by the prefix in force (any case), #n and n name the ticket's number", () => {
  for (const ref of ["FRM-1", "frm-1", "#1", "1", " #1 "]) {
    expect(ticketRefOf(ref, "FRM-"), ref).toEqual({ num: 1 });
  }
  expect(ticketRefOf(ticketKey("BAY-", 42), "BAY-")).toEqual({ num: 42 });
});

test("anything else is taken as an id: a ULID, another prefix's key, a bare prefix", () => {
  const ulid = "01M2DSQ4FQJP6JVVDPHV9932CD";
  expect(ticketRefOf(ulid, "FRM-")).toEqual({ id: ulid });
  for (const ref of ["BAY-1", "FRM-", "#FRM-1", "FRM-1a", "#", ""]) {
    expect(ticketRefOf(ref, "FRM-"), ref).toEqual({ id: ref });
  }
});
