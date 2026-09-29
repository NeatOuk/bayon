import { NOTIFY_SMTP_URL_SECRET, err, ok, type Result } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import { createTransport } from "nodemailer";
import { z } from "zod";
import { scrubSecrets, urlSecretParts } from "../../secret-scrub.js";
import {
  causeText,
  channelError,
  unconfigured,
  type ChannelSender,
  type Outbound,
} from "./channel.js";

// Email over SMTP, through nodemailer. The server, its user and password are one URL in
// the host store, NOTIFY_SMTP_URL: `smtps://user:pass@host:465` (TLS from the first byte) or
// `smtp://…:587`, which must upgrade with STARTTLS or fail (`requireTLS`) — a password never crosses
// in the clear. The recipient is the shell-only `notify.email.to`; the sender `notify.email.from`,
// else the URL's user when that is an address. Every step has a timeout, and a whole send has one
// cap; nothing is pooled, so no connection outlives its send.

export const SMTP_STEP_TIMEOUT_MS = 15_000;
export const SMTP_SEND_TIMEOUT_MS = 30_000;

/** Who a message goes to and from, as the shell-only settings hold them ("" is unset). */
export interface MailParties {
  readonly to: string;
  readonly from: string;
}

/** The options nodemailer's SMTP transport is built with: TLS always, no pool, bounded waits. */
export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** smtps: TLS from the first byte. */
  readonly secure: boolean;
  /** smtp: STARTTLS or nothing. */
  readonly requireTLS: boolean;
  readonly auth?: { readonly user: string; readonly pass: string };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
  readonly tls: { readonly minVersion: "TLSv1.2" };
}

/** What sends one message; nodemailer's transport in production, a test's stub otherwise. */
export interface MailTransport {
  sendMail(message: {
    readonly from: string;
    readonly to: string;
    readonly subject: string;
    readonly text: string;
    readonly disableFileAccess: true;
    readonly disableUrlAccess: true;
  }): Promise<unknown>;
  close(): void;
}

export type MakeTransport = (options: SmtpOptions) => MailTransport;

const nodemailerTransport: MakeTransport = (options) =>
  createTransport({
    ...options,
    auth: options.auth === undefined ? undefined : { ...options.auth },
  });

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const Address = z.email();

/** NOTIFY_SMTP_URL as transport options, or why it cannot be one (never quoting it). */
export function smtpOptions(raw: string): Result<SmtpOptions> {
  const refuse = (why: string) =>
    err(
      channelError(
        "validation",
        `${NOTIFY_SMTP_URL_SECRET} ${why}`,
        false,
        urlSecretParts(raw),
      ),
    );
  if (!URL.canParse(raw)) return refuse("is not a URL");
  const url = new URL(raw);
  if (url.protocol !== "smtps:" && url.protocol !== "smtp:")
    return refuse(
      "must be smtps://user:pass@host:465 or smtp://user:pass@host:587",
    );
  if (url.hostname === "") return refuse("names no host");
  const secure = url.protocol === "smtps:";
  const port = url.port === "" ? (secure ? 465 : 587) : Number(url.port);
  const user = decode(url.username);
  const pass = decode(url.password);
  return ok({
    host: url.hostname,
    port,
    secure,
    requireTLS: !secure,
    ...(user === "" ? {} : { auth: { user, pass } }),
    connectionTimeout: SMTP_STEP_TIMEOUT_MS,
    greetingTimeout: SMTP_STEP_TIMEOUT_MS,
    socketTimeout: SMTP_STEP_TIMEOUT_MS,
    tls: { minVersion: "TLSv1.2" },
  });
}

/** The message's text: the body, then the link on its own line. */
export const mailText = (o: Outbound): string =>
  o.link === null ? o.body : `${o.body}\n\n${o.link}`;

const SmtpFailure = z.object({
  code: z.string().optional().catch(undefined),
  responseCode: z.number().optional().catch(undefined),
});

/** A refused login, a refused address or any 5xx: sending again would be refused again. */
function refusedForGood(e: unknown): boolean {
  const f = SmtpFailure.safeParse(e);
  if (!f.success) return false;
  const { code, responseCode } = f.data;
  return (
    code === "EAUTH" ||
    code === "EENVELOPE" ||
    (responseCode !== undefined && responseCode >= 500 && responseCode < 600)
  );
}

export interface EmailDeps {
  readonly secrets: SecretStore;
  readonly parties: () => Promise<MailParties>;
  readonly makeTransport?: MakeTransport;
  readonly sendTimeoutMs?: number;
}

/** Races the send against its cap; the transport is closed either way. */
async function sendCapped(
  transport: MailTransport,
  message: Parameters<MailTransport["sendMail"]>[0],
  capMs: number,
): Promise<"sent" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), capMs);
  });
  try {
    return await Promise.race([
      transport.sendMail(message).then(() => "sent" as const),
      cap,
    ]);
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}

export function emailChannel(deps: EmailDeps): ChannelSender {
  const make = deps.makeTransport ?? nodemailerTransport;
  const capMs = deps.sendTimeoutMs ?? SMTP_SEND_TIMEOUT_MS;
  return {
    channel: "email",
    configured: async () =>
      (await deps.secrets.get(NOTIFY_SMTP_URL_SECRET)).ok &&
      (await deps.parties()).to !== "",
    send: async (o) => {
      const url = await deps.secrets.get(NOTIFY_SMTP_URL_SECRET);
      if (!url.ok)
        return unconfigured(
          `${NOTIFY_SMTP_URL_SECRET} is not in the host secret store`,
        );
      const parties = await deps.parties();
      // A one-message override: the change alert goes to the address being replaced.
      const to = o.to !== undefined && o.to !== "" ? o.to : parties.to;
      if (to === "") return unconfigured("notify.email.to is not set");
      const options = smtpOptions(url.value);
      if (!options.ok) return options;
      const secrets = urlSecretParts(url.value);
      const user = options.value.auth?.user ?? "";
      const from =
        parties.from !== ""
          ? parties.from
          : Address.safeParse(user).success
            ? user
            : "";
      if (from === "")
        return err(
          channelError(
            "validation",
            "set notify.email.from: the SMTP user is not an email address",
            false,
            secrets,
          ),
        );
      try {
        const done = await sendCapped(
          make(options.value),
          {
            from,
            to,
            // One header line, whatever the title held: nodemailer folds, this refuses to depend on it.
            subject: o.title.replace(/[\r\n]+/g, " ").trim(),
            text: mailText(o),
            disableFileAccess: true,
            disableUrlAccess: true,
          },
          capMs,
        );
        return done === "sent"
          ? ok(undefined)
          : err(
              channelError(
                "timeout",
                `the SMTP send did not finish within ${capMs} ms`,
                true,
              ),
            );
      } catch (e) {
        // Scrubbed whole, then cut, so no fragment of a secret outlives the scrub.
        const said = scrubSecrets(causeText(e).trim(), secrets).slice(0, 300);
        return err(
          channelError(
            "runner_error",
            `the SMTP send failed: ${said}`,
            !refusedForGood(e),
            secrets,
          ),
        );
      }
    },
  };
}
