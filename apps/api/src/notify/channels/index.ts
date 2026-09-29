import type { NotifyChannel } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import type { ChannelSender, Fetch } from "./channel.js";
import { emailChannel, type MailParties, type MakeTransport } from "./email.js";
import { macChannel, type ExecFile } from "./mac.js";
import { ntfyChannel } from "./ntfy.js";
import { webhookChannel } from "./webhook.js";

// The four channels, built once at boot over the host secret store the Jira token is
// read from: every destination is read from it at each send, never kept.

export type ChannelSet = Readonly<Record<NotifyChannel, ChannelSender>>;

export interface ChannelDeps {
  readonly secrets: SecretStore;
  /** The shell-only recipient and sender, read at each send. */
  readonly parties: () => Promise<MailParties>;
  readonly fetch?: Fetch;
  readonly httpTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly execFile?: ExecFile;
  readonly makeTransport?: MakeTransport;
}

export function buildChannels(d: ChannelDeps): ChannelSet {
  const http = {
    secrets: d.secrets,
    ...(d.fetch === undefined ? {} : { fetch: d.fetch }),
    ...(d.httpTimeoutMs === undefined ? {} : { timeoutMs: d.httpTimeoutMs }),
  };
  return {
    mac: macChannel({
      ...(d.platform === undefined ? {} : { platform: d.platform }),
      ...(d.execFile === undefined ? {} : { execFile: d.execFile }),
    }),
    ntfy: ntfyChannel(http),
    webhook: webhookChannel(http),
    email: emailChannel({
      secrets: d.secrets,
      parties: d.parties,
      ...(d.makeTransport === undefined
        ? {}
        : { makeTransport: d.makeTransport }),
    }),
  };
}

export type { ChannelSender, Fetch, Outbound } from "./channel.js";
