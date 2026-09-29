import {
  capText,
  err,
  NOTIFY_ERROR_MAX,
  type ErrorClass,
  type FrmError,
  type NotifyChannel,
  type Result,
} from "@bayon/core";
import { scrubSecrets } from "../../secret-scrub.js";

// One notification channel: `send` answers ok, or a typed error the deliverer acts on —
// `not_found` is "not configured here" (the secret is absent, this is not a Mac, no recipient), so
// the delivery is skipped and never retried; any other error is retried while `retryable` and the
// backoff lasts. Every message a channel builds names the channel, never its destination, and is
// scrubbed of every secret it read before it leaves.

/** What every channel sends: the text, and the deep link when `notify.base_url` is set. */
export interface Outbound {
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  /**
   * The email channel only, and only for one message: the address it goes to instead of
   * `notify.email.to`. The outbox never sets it; the destination-change alert does, so
   * the address that is losing the mail is the one told it is (§14). Every other channel ignores it.
   */
  readonly to?: string;
}

export interface ChannelSender {
  readonly channel: NotifyChannel;
  /** Whether a send could go now: the secret is present, this is a Mac. A boolean, never a value. */
  configured(): Promise<boolean>;
  send(o: Outbound, signal?: AbortSignal): Promise<Result<void>>;
}

/** `fetch`, injected: tests point it at a local fixture server. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A channel's error: capped, and scrubbed of `secrets` in every form. */
export function channelError(
  errorClass: ErrorClass,
  message: string,
  retryable: boolean,
  secrets: readonly string[] = [],
): FrmError {
  return {
    class: errorClass,
    message: capText(scrubSecrets(message, secrets), NOTIFY_ERROR_MAX),
    retryable,
  };
}

/** Not configured: the delivery is skipped. */
export const unconfigured = (message: string): Result<never> =>
  err(channelError("not_found", message, false));

/** The messages a thrown error carries, its causes' included. */
export function causeText(e: unknown, depth = 0): string {
  if (!(e instanceof Error) || depth > 3) return "";
  const code = "code" in e && typeof e.code === "string" ? ` ${e.code}` : "";
  return `${e.message}${code} ${causeText(e.cause, depth + 1)}`;
}
