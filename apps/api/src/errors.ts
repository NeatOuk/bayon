import {
  AdmissionRefusalCause,
  LawRefusalCause,
  type ErrorClass,
  type FrmError,
  type Result,
} from "@bayon/core";
import type { ApiErrorBody, WireError } from "@bayon/proto";
import {
  Catch,
  HttpException,
  Logger,
  StandardSchemaValidationPipe,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { z } from "zod";

// Every non-2xx body is `{ error: { class, message, retryable } }` (proto `ApiErrorBody`), plus
// `current_version` on a stale compare-and-set (M1 contract 3).

const STATUS_BY_CLASS: Readonly<Partial<Record<ErrorClass, number>>> = {
  validation: 400,
  unknown_command: 400,
  not_found: 404,
  conflict: 409,
  law_refused: 422,
  admission_refused: 429,
  db_busy: 503,
};

const CLASS_BY_STATUS: Readonly<Record<number, ErrorClass>> = {
  404: "not_found",
  409: "conflict",
  429: "admission_refused",
};

export const httpStatus = (errorClass: ErrorClass): number =>
  STATUS_BY_CLASS[errorClass] ?? 500;

/** An FrmError on its way out as a response. `status` defaults from the error class. */
export class FrmHttpError extends Error {
  readonly error: FrmError;
  readonly status: number;

  constructor(error: FrmError, status = httpStatus(error.class)) {
    super(error.message);
    this.name = "FrmHttpError";
    this.error = error;
    this.status = status;
  }
}

/** The value, or throws it as a response. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new FrmHttpError(result.error);
}

const StaleWrite = z.object({ current_version: z.int().nonnegative() });

/** The one `cause` fact that leaves the server: the current version behind a stale write's 409. */
function currentVersion(error: FrmError): Pick<WireError, "current_version"> {
  if (error.class !== "conflict") return {};
  const stale = StaleWrite.safeParse(error.cause);
  return stale.success ? { current_version: stale.data.current_version } : {};
}

/** A 422's rule, reason and detail (M1 contract 2); a cause that does not parse sends none. */
function refusalFields(
  error: FrmError,
): Pick<WireError, "rule" | "reason" | "detail"> {
  if (error.class !== "law_refused") return {};
  const refusal = LawRefusalCause.safeParse(error.cause);
  return refusal.success ? refusal.data : {};
}

/** An admission refusal's gate; a cause that does not parse sends none. */
function admissionFields(error: FrmError): Pick<WireError, "gate"> {
  if (error.class !== "admission_refused") return {};
  const cause = AdmissionRefusalCause.safeParse(error.cause);
  return cause.success ? { gate: cause.data.gate } : {};
}

/** The cause facts that leave the server, flattened: a response's, and a stored command's. */
export const wireFields = (
  error: FrmError,
): Pick<
  WireError,
  "current_version" | "rule" | "reason" | "detail" | "gate"
> => ({
  ...currentVersion(error),
  ...refusalFields(error),
  ...admissionFields(error),
});

/** 5xx bodies name the class only; the details go to the server log. */
function toResponse(exception: unknown): {
  readonly status: number;
  readonly error: WireError;
} {
  if (exception instanceof FrmHttpError) {
    const { class: errorClass, message, retryable } = exception.error;
    return {
      status: exception.status,
      error: {
        class: errorClass,
        message:
          exception.status >= 500 ? `request failed: ${errorClass}` : message,
        retryable,
        ...wireFields(exception.error),
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const internal = status >= 500;
    return {
      status,
      error: {
        class:
          CLASS_BY_STATUS[status] ?? (internal ? "internal" : "validation"),
        message: internal ? "request failed: internal" : exception.message,
        retryable: false,
      },
    };
  }
  return {
    status: 500,
    error: {
      class: "internal",
      message: "request failed: internal",
      retryable: false,
    },
  };
}

function describe(exception: unknown): string {
  if (exception instanceof FrmHttpError)
    return `${exception.error.class}: ${exception.error.message} ${String(exception.error.cause ?? "")}`;
  return exception instanceof Error
    ? (exception.stack ?? exception.message)
    : String(exception);
}

interface HttpResponse {
  status(code: number): { json(body: ApiErrorBody): void };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  readonly #logger = new Logger("api");

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, error } = toResponse(exception);
    if (status >= 500) this.#logger.error(describe(exception));
    host
      .switchToHttp()
      .getResponse<HttpResponse>()
      .status(status)
      .json({ error });
  }
}

interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

const formatIssue = (issue: Issue): string => {
  const path = (issue.path ?? [])
    .map((part) => String(typeof part === "object" ? part.key : part))
    .join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
};

/** Validates every `@Body/@Query/@Param({ schema })` against its zod schema. */
export const validationPipe = new StandardSchemaValidationPipe({
  exceptionFactory: (issues: readonly Issue[]) =>
    new FrmHttpError({
      class: "validation",
      message: issues.map(formatIssue).join("; "),
      retryable: false,
    }),
});
