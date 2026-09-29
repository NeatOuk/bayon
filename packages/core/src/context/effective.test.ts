import { expect, test } from "vitest";
import { effectiveCompression } from "./effective.js";

// Every row of the truth table: on only when all three hold and the session is not MCP-only.
const ROWS = [false, true].flatMap((projectOn) =>
  [false, true].flatMap((adapterSupports) =>
    [false, true].flatMap((executorLocal) =>
      [false, true].map((mcpOnly) => ({
        projectOn,
        adapterSupports,
        executorLocal,
        mcpOnly,
      })),
    ),
  ),
);

test("the table has all 16 rows", () => expect(ROWS).toHaveLength(16));

test("of the 16, only the row with all three on and not MCP-only is on", () => {
  expect(ROWS.filter((f) => effectiveCompression(f))).toEqual([
    {
      projectOn: true,
      adapterSupports: true,
      executorLocal: true,
      mcpOnly: false,
    },
  ]);
});
