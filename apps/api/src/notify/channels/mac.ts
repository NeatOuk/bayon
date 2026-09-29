import { execFile as nodeExecFile } from "node:child_process";
import { err, ok } from "@bayon/core";
import {
  causeText,
  channelError,
  unconfigured,
  type ChannelSender,
} from "./channel.js";

// This Mac's Notification Center, through `osascript`. The script is three constant
// lines that read the title and body from `argv`; the two strings reach osascript only as
// arguments after `--`, through execFile (no shell). Nothing is ever built into AppleScript source,
// so a title holding quotes, `$(…)` or backticks is shown, never run. Off macOS the channel is
// unavailable: the delivery is skipped, not failed.

export const OSASCRIPT = "/usr/bin/osascript";
export const MAC_TIMEOUT_MS = 10_000;

/** The whole script. Constant: a test holds it to exactly these lines. */
export const MAC_SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
] as const;

/** osascript's argv: the script's lines, then `--`, then the two values as data. */
export const macArgv = (title: string, body: string): string[] => [
  ...MAC_SCRIPT.flatMap((line) => ["-e", line]),
  "--",
  title,
  body,
];

export type ExecFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number },
) => Promise<void>;

const execFileAsync: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], { timeout: options.timeout }, (e) => {
      if (e === null) resolve();
      else reject(e);
    });
  });

export interface MacDeps {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: ExecFile;
  readonly timeoutMs?: number;
}

export function macChannel(deps: MacDeps = {}): ChannelSender {
  const platform = deps.platform ?? process.platform;
  const run = deps.execFile ?? execFileAsync;
  const timeout = deps.timeoutMs ?? MAC_TIMEOUT_MS;
  return {
    channel: "mac",
    configured: () => Promise.resolve(platform === "darwin"),
    send: async (o) => {
      if (platform !== "darwin")
        return unconfigured(`Mac notifications are unavailable on ${platform}`);
      try {
        await run(OSASCRIPT, macArgv(o.title, o.body), { timeout });
        return ok(undefined);
      } catch (e) {
        const killed = e instanceof Error && "killed" in e && e.killed === true;
        return err(
          killed
            ? channelError(
                "timeout",
                `osascript did not finish within ${timeout} ms`,
                true,
              )
            : channelError(
                "runner_error",
                `osascript failed: ${causeText(e).trim().slice(0, 200)}`,
                true,
              ),
        );
      }
    },
  };
}
