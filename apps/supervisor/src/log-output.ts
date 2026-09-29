// How the supervisor's log reaches its terminal. A person at a terminal (stdout is a
// TTY) reads one short human line per record, warnings and worse by default; a log file (the
// operator's `> supervisor.log`, a container's stdout) keeps pino's JSON at `info`, exactly as
// before, which log_scan and anyone grepping it rely on. FRM_LOG_FORMAT and FRM_LOG_LEVEL override.
import { z } from "zod";

export const LogFormat = z.enum(["json", "human"]);
export type LogFormat = z.infer<typeof LogFormat>;
export const LogLevel = z.enum([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
export type LogLevel = z.infer<typeof LogLevel>;

export interface LogSetup {
  readonly format: LogFormat;
  readonly level: LogLevel;
}

/** The format and level: the env's when set, else by whether a person is watching. */
export function logSetup(
  env: {
    readonly FRM_LOG_FORMAT?: LogFormat;
    readonly FRM_LOG_LEVEL?: LogLevel;
  },
  isTty: boolean,
): LogSetup {
  const format = env.FRM_LOG_FORMAT ?? (isTty ? "human" : "json");
  return {
    format,
    level: env.FRM_LOG_LEVEL ?? (format === "human" ? "warn" : "info"),
  };
}

const LEVEL_NAMES: Readonly<Record<number, string>> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const LogRecord = z.looseObject({
  level: z.number(),
  time: z.number().optional(),
  msg: z.string().optional(),
  component: z.string().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
  err: z.unknown().optional(),
});

const clockOf = (time: number | undefined): string =>
  time === undefined ? "--:--:--" : new Date(time).toISOString().slice(11, 19);

/** `err` as pino writes it: a string, or an object (a serialised Error) with a message. */
function causeOf(err: unknown): string | undefined {
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err)
    return typeof err.message === "string" ? err.message : undefined;
  return undefined;
}

/** One pino JSON record as one human line: `HH:MM:SS level [component] message: cause`. */
export function humanLine(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json.trimEnd();
  }
  const r = LogRecord.safeParse(parsed);
  if (!r.success) return json.trimEnd();
  const level = (LEVEL_NAMES[r.data.level] ?? String(r.data.level)).padEnd(5);
  const component =
    r.data.component === undefined ? "" : `${r.data.component}: `;
  const cause = r.data.error?.message ?? causeOf(r.data.err);
  const message = r.data.msg ?? "";
  return `${clockOf(r.data.time)} ${level} ${component}${message}${cause === undefined ? "" : `: ${cause}`}`;
}

/** A pino destination that writes human lines to `write`. */
export const humanDestination = (write: (text: string) => void) => ({
  write: (line: string): void => {
    for (const record of line.split("\n")) {
      if (record.trim() !== "") write(`${humanLine(record)}\n`);
    }
  },
});
