import { NOTIFY_NTFY_URL_SECRET } from "@bayon/core";
import type { SecretStore } from "@bayon/executors";
import { unconfigured, type ChannelSender, type Fetch } from "./channel.js";
import { postHttps } from "./http.js";

// ntfy: the text POSTed to the topic URL stored as NOTIFY_NTFY_URL, the title in the
// `Title` header and the deep link in `Click`, so tapping the phone's notification opens the GUI.
// The topic URL is the credential (anyone holding it can read the topic), so it lives only in the
// host store; a self-hosted server's user and password ride in its userinfo as Basic auth.

// A header takes printable ASCII only.
const NOT_PRINTABLE_ASCII = /[^ -~]/;

/** A header value: one line, and RFC 2047 base64 when it is not printable ASCII (ntfy decodes it). */
export function headerText(text: string): string {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  return NOT_PRINTABLE_ASCII.test(line)
    ? `=?UTF-8?B?${Buffer.from(line, "utf8").toString("base64")}?=`
    : line;
}

export interface NtfyDeps {
  readonly secrets: SecretStore;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
}

export function ntfyChannel(deps: NtfyDeps): ChannelSender {
  const doFetch: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    channel: "ntfy",
    configured: async () => (await deps.secrets.get(NOTIFY_NTFY_URL_SECRET)).ok,
    send: async (o, signal) => {
      const url = await deps.secrets.get(NOTIFY_NTFY_URL_SECRET);
      if (!url.ok)
        return unconfigured(
          `${NOTIFY_NTFY_URL_SECRET} is not in the host secret store`,
        );
      return postHttps({
        channel: "ntfy",
        secretName: NOTIFY_NTFY_URL_SECRET,
        url: url.value,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Title: headerText(o.title),
          ...(o.link === null ? {} : { Click: headerText(o.link) }),
        },
        body: o.body === "" ? o.title : o.body,
        fetch: doFetch,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
