import { err, ok } from "@bayon/core";
import {
  HttpException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  type ArgumentsHost,
} from "@nestjs/common";
import { beforeAll, describe, expect, test } from "vitest";
import { ErrorFilter, FrmHttpError, httpStatus, unwrap } from "./errors.js";

beforeAll(() => Logger.overrideLogger(false));

/** Runs the filter against a fake Express response and returns what it sent. */
function respond(exception: unknown): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const response = {
    status: (code: number) => {
      status = code;
      return { json: (sent: unknown) => (body = sent) };
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  new ErrorFilter().catch(exception, host);
  return { status, body };
}

describe("ErrorFilter", () => {
  test("a 4xx FrmError keeps its class and message", () => {
    const error = {
      class: "conflict",
      message: "key reused",
      retryable: false,
    } as const;
    expect(respond(new FrmHttpError(error))).toEqual({
      status: 409,
      body: { error },
    });
  });

  test("a 5xx FrmError names only its class; the details stay in the log", () => {
    const internal = new FrmHttpError({
      class: "internal",
      message: "SQLITE_CORRUPT in /home/op/.frm/foreman.db",
      retryable: false,
      cause: new Error("disk"),
    });
    expect(respond(internal)).toEqual({
      status: 500,
      body: {
        error: {
          class: "internal",
          message: "request failed: internal",
          retryable: false,
        },
      },
    });
    const busy = new FrmHttpError({
      class: "db_busy",
      message: "busy",
      retryable: true,
    });
    expect(respond(busy)).toEqual({
      status: 503,
      body: {
        error: {
          class: "db_busy",
          message: "request failed: db_busy",
          retryable: true,
        },
      },
    });
  });

  test("Nest's HTTP exceptions map by status", () => {
    expect(respond(new NotFoundException("Cannot GET /x"))).toEqual({
      status: 404,
      body: {
        error: {
          class: "not_found",
          message: "Cannot GET /x",
          retryable: false,
        },
      },
    });
    expect(respond(new PayloadTooLargeException("too big"))).toEqual({
      status: 413,
      body: {
        error: { class: "validation", message: "too big", retryable: false },
      },
    });
    expect(respond(new HttpException("upstream secret", 502))).toEqual({
      status: 502,
      body: {
        error: {
          class: "internal",
          message: "request failed: internal",
          retryable: false,
        },
      },
    });
  });

  test("a law refusal is 422 with its rule, reason and detail (M1 contract 2)", () => {
    const refusal = new FrmHttpError({
      class: "law_refused",
      message: "start_spike: no live session holds ticket T1",
      retryable: false,
      cause: {
        rule: "start_spike",
        reason: "no_session",
        detail: "no live session holds ticket T1",
      },
    });
    expect(respond(refusal)).toEqual({
      status: 422,
      body: {
        error: {
          class: "law_refused",
          message: "start_spike: no live session holds ticket T1",
          retryable: false,
          rule: "start_spike",
          reason: "no_session",
          detail: "no live session holds ticket T1",
        },
      },
    });
  });

  test("a refusal whose cause does not parse sends no refusal fields", () => {
    const odd = new FrmHttpError({
      class: "law_refused",
      message: "x: y",
      retryable: false,
      cause: { rule: "x" },
    });
    expect(respond(odd)).toEqual({
      status: 422,
      body: {
        error: { class: "law_refused", message: "x: y", retryable: false },
      },
    });
  });

  test("anything else is a generic 500", () => {
    for (const thrown of [new Error("kaboom"), "a string"]) {
      expect(respond(thrown)).toEqual({
        status: 500,
        body: {
          error: {
            class: "internal",
            message: "request failed: internal",
            retryable: false,
          },
        },
      });
    }
  });
});

describe("helpers", () => {
  test("httpStatus maps the classes a client can act on; the rest are 500", () => {
    expect(httpStatus("validation")).toBe(400);
    expect(httpStatus("admission_refused")).toBe(429);
    expect(httpStatus("spawn_failed")).toBe(500);
  });

  test("unwrap returns the value or throws it as an FrmHttpError", () => {
    expect(unwrap(ok(7))).toBe(7);
    const error = {
      class: "not_found",
      message: "gone",
      retryable: false,
    } as const;
    expect(() => unwrap(err(error))).toThrow(FrmHttpError);
  });
});
