import { afterEach, expect, test, vi } from "vitest";
import { QuietLogger, apiLogger } from "./quiet-logger.js";

// The API prints its URL and little else at the default level.

afterEach(() => {
  vi.restoreAllMocks();
});

function written(run: (logger: QuietLogger) => void): string {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  run(new QuietLogger());
  vi.restoreAllMocks();
  return chunks.join("");
}

test("Nest's boot lines are dropped", () => {
  expect(
    written((l) => {
      l.log("Mapped {/api/v1/health, GET} route", "RouterExplorer");
      l.log("AppModule dependencies initialized", "InstanceLoader");
      l.log("Starting Nest application...", "NestFactory");
      l.log("Nest application successfully started", "NestApplication");
    }),
  ).toBe("");
});

test("our own lines, and Nest's warnings and errors, still print", () => {
  const out = written((l) => {
    l.log("sync done", "jira");
    l.warn("a route is slow", "RouterExplorer");
    l.error("boom", undefined, "NestApplication");
  });
  expect(out).toContain("sync done");
  expect(out).toContain("a route is slow");
  expect(out).toContain("boom");
});

test("FRM_LOG_LEVEL=debug or trace keeps Nest's default logger", () => {
  expect(apiLogger({})).toBeInstanceOf(QuietLogger);
  expect(apiLogger({ FRM_LOG_LEVEL: "info" })).toBeInstanceOf(QuietLogger);
  expect(apiLogger({ FRM_LOG_LEVEL: "debug" })).toBeUndefined();
  expect(apiLogger({ FRM_LOG_LEVEL: "trace" })).toBeUndefined();
});
