import { describe, expect, test } from "vitest";
import { FrmHttpError } from "../errors.js";
import { ifMatchVersion } from "./if-match.js";

// Contract 3: PATCH and transition need `If-Match: "<version>"`; 428 without it, 400 if malformed.

const thrown = (raw: string | undefined): FrmHttpError => {
  try {
    ifMatchVersion(raw);
  } catch (error) {
    if (error instanceof FrmHttpError) return error;
  }
  throw new Error(`expected ${String(raw)} to be refused`);
};

describe("ifMatchVersion", () => {
  test.each([
    ['"7"', 7],
    ["7", 7],
    ['"12"', 12],
  ])("%s is version %i", (raw, version) => {
    expect(ifMatchVersion(raw)).toBe(version);
  });

  test("a missing header is 428", () => {
    const error = thrown(undefined);
    expect(error.status).toBe(428);
    expect(error.error).toMatchObject({
      class: "validation",
      message: 'If-Match: "<version>" is required',
    });
  });

  test.each(["", "*", 'W/"7"', '"7', "0", '"0"', "abc", '"7", "8"', "1e3"])(
    "%s is 400",
    (raw) => {
      const error = thrown(raw);
      expect(error.status).toBe(400);
      expect(error.error.class).toBe("validation");
    },
  );
});
