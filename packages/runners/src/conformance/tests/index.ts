// The §15 tests, in order.
import type { ConformanceTest } from "./define.js";
import { t02, t03, t04, t05, t06 } from "./session-a.js";
import { t01 } from "./t01-version.js";
import { t07 } from "./t07-interrupt.js";
import { t08 } from "./t08-kill-adopt.js";
import { t09 } from "./t09-no-terminal.js";
import { t10 } from "./t10-unknown.js";
import { t11 } from "./t11-mcp.js";
import { t12 } from "./t12-permissions.js";
import { t13 } from "./t13-review.js";
import { t14 } from "./t14-home.js";
import { t15 } from "./t15-concurrent-home.js";
import { t16 } from "./t16-roots.js";
import { t17 } from "./t17-compression.js";

export const TESTS: readonly ConformanceTest[] = [
  t01,
  t02,
  t03,
  t04,
  t05,
  t06,
  t07,
  t08,
  t09,
  t10,
  t11,
  t12,
  t13,
  t14,
  t15,
  t16,
];

/** §15 #17 (spec M12): only in a run with compression on, after the base suite. */
export const COMPRESSION_TESTS: readonly ConformanceTest[] = [t17];
