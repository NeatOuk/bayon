import type { NotifyChannel, NotifyConfigPatch } from "@bayon/core";
import {
  NotifyChannelsView,
  NotifyConfigView,
  NotifyTestResult,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { ApiRequestError, getJson, postJson, putJson } from "@/api/http";

// Settings → Notifications' REST (door, screen): each channel's status
// (booleans and the name of the secret to store, never a destination), one test send, and the three
// destination settings behind their audited door.

export const NOTIFY_CHANNELS_KEY = ["notify-channels"] as const;
export const NOTIFY_CONFIG_KEY = ["notify-config"] as const;

/** `GET /notifications/channels`. */
export const notifyChannelsQuery = queryOptions({
  queryKey: NOTIFY_CHANNELS_KEY,
  queryFn: ({ signal }) =>
    getJson("/notifications/channels", NotifyChannelsView, signal),
});

/** `GET /notifications/config`: the mail recipient and sender and the link origin; "" is unset. */
export const notifyConfigQuery = queryOptions({
  queryKey: NOTIFY_CONFIG_KEY,
  queryFn: ({ signal }) =>
    getJson("/notifications/config", NotifyConfigView, signal),
});

/** `POST /notifications/test`: one send now, whatever the switch and quiet hours say. */
export const sendNotifyTest = (
  channel: NotifyChannel,
): Promise<NotifyTestResult> =>
  postJson("/notifications/test", { channel }, NotifyTestResult);

/** `PUT /notifications/config`: those three names only; every change is audited and announced. */
export const putNotifyConfig = (
  patch: NotifyConfigPatch,
): Promise<NotifyConfigView> =>
  putJson("/notifications/config", patch, NotifyConfigView);

/**
 * The 409 of a test sent moments ago: the door lets one per channel every few seconds, so the
 * button cannot be used to flood a destination. Not a failure — the first test is on its way.
 */
export const isTestCooldown = (error: unknown): boolean =>
  error instanceof ApiRequestError && error.status === 409;

/** A failed call in the server's own words, which say what to fix. */
export const refusalMessage = (error: unknown): string =>
  error instanceof ApiRequestError ? error.error.message : String(error);
