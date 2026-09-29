import { NOTIFY_WEBHOOK_URL_SECRET } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import {
  unconfigured,
  type ChannelSender,
  type Fetch,
  type Outbound,
} from "./channel.js";
import { postHttps } from "./http.js";

// A webhook: JSON POSTed to the URL stored as NOTIFY_WEBHOOK_URL — `{text, title,
// link}` for a generic receiver, or Slack's own `{text}` when the host is Slack's incoming-webhook
// host, the title bold and the link as Slack's `<url|label>`. The URL is the credential (a Slack
// webhook's path is its secret), so it lives only in the host store.

const SLACK_HOST = "hooks.slack.com";

export const isSlackWebhook = (url: string): boolean =>
  URL.canParse(url) && new URL(url).hostname === SLACK_HOST;

/** Slack's three control characters, as its mrkdwn wants them. */
const slackEscape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A link inside Slack's `<url|label>`: nothing in it may close the brackets. */
const slackUrl = (url: string): string =>
  url.replaceAll("|", "%7C").replaceAll(">", "%3E").replaceAll("<", "%3C");

/** The body the receiver gets. */
export function webhookPayload(url: string, o: Outbound): string {
  if (!isSlackWebhook(url))
    return JSON.stringify({ text: o.body, title: o.title, link: o.link });
  const lines = [
    `*${slackEscape(o.title)}*`,
    ...(o.body === "" ? [] : [slackEscape(o.body)]),
    ...(o.link === null ? [] : [`<${slackUrl(o.link)}|Open in Bayon>`]),
  ];
  return JSON.stringify({ text: lines.join("\n") });
}

export interface WebhookDeps {
  readonly secrets: SecretStore;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
}

export function webhookChannel(deps: WebhookDeps): ChannelSender {
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    channel: "webhook",
    configured: async () =>
      (await deps.secrets.get(NOTIFY_WEBHOOK_URL_SECRET)).ok,
    send: async (o, signal) => {
      const url = await deps.secrets.get(NOTIFY_WEBHOOK_URL_SECRET);
      if (!url.ok)
        return unconfigured(
          `${NOTIFY_WEBHOOK_URL_SECRET} is not in the host secret store`,
        );
      return postHttps({
        channel: "webhook",
        secretName: NOTIFY_WEBHOOK_URL_SECRET,
        url: url.value,
        headers: { "Content-Type": "application/json" },
        body: webhookPayload(url.value, o),
        fetch: doFetch,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
