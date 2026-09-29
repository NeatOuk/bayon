import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { humanDestination, humanLine, logSetup } from "./log-output.js";

// The supervisor's terminal output: human lines at a terminal, JSON to a file.

describe("logSetup", () => {
  test("a terminal: human lines, warnings and worse", () => {
    expect(logSetup({}, true)).toEqual({ format: "human", level: "warn" });
  });

  test("a file or a pipe: JSON at info, as the live install's supervisor.log has always had", () => {
    expect(logSetup({}, false)).toEqual({ format: "json", level: "info" });
  });

  test("FRM_LOG_FORMAT and FRM_LOG_LEVEL win", () => {
    expect(logSetup({ FRM_LOG_FORMAT: "json" }, true)).toEqual({
      format: "json",
      level: "info",
    });
    expect(logSetup({ FRM_LOG_LEVEL: "debug" }, true)).toEqual({
      format: "human",
      level: "debug",
    });
    expect(logSetup({ FRM_LOG_FORMAT: "human" }, false).format).toBe("human");
  });
});

describe("humanLine", () => {
  test("time, level, component, message and the error's message", () => {
    expect(
      humanLine(
        JSON.stringify({
          level: 40,
          time: Date.UTC(2026, 8, 29, 9, 3, 4),
          component: "backup",
          msg: "backups are off until you run: pnpm frm backup init-key",
        }),
      ),
    ).toBe(
      "09:03:04 warn  backup: backups are off until you run: pnpm frm backup init-key",
    );
    expect(
      humanLine(
        JSON.stringify({
          level: 60,
          time: 0,
          msg: "the supervisor could not start",
          error: { class: "validation", message: "no FRM_HOME" },
        }),
      ),
    ).toBe("00:00:00 fatal the supervisor could not start: no FRM_HOME");
  });

  test("err as an object (a serialised Error) prints its message; as a string, itself", () => {
    expect(
      humanLine(
        JSON.stringify({
          level: 50,
          time: 0,
          msg: "sweep: a row failed",
          err: { type: "Error", message: "EACCES", stack: "..." },
        }),
      ),
    ).toBe("00:00:00 error sweep: a row failed: EACCES");
    expect(
      humanLine(JSON.stringify({ level: 50, time: 0, msg: "m", err: "boom" })),
    ).toBe("00:00:00 error m: boom");
  });

  test("anything that is not a record passes through", () => {
    expect(humanLine("plain text\n")).toBe("plain text");
    expect(humanLine('{"no":"level"}')).toBe('{"no":"level"}');
  });

  test("as a pino destination: one line per record, no JSON", () => {
    const out: string[] = [];
    const log = pino(
      { level: "info", base: undefined },
      humanDestination((text) => out.push(text)),
    );
    log.child({ component: "sweep" }).info("sweep: pass done");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(
      /^\d\d:\d\d:\d\d info {2}sweep: sweep: pass done\n$/,
    );
  });
});
