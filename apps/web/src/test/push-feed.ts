import type {
  Fleet,
  GatesPage,
  InboxPage,
  OnFleet,
  OnGates,
  OnInbox,
  OnPulses,
  OnSpend,
  OnTicketEvents,
  PulsesPage,
  SpendSummary,
  TicketEventView,
} from "@bayon/proto";
import { act } from "@testing-library/react";
import type { Feed } from "@/feed/feed";
import { silentFeed } from "@/test/render";

/** Every listener of a topic gets the frame, as the real client's fan-out delivers it. */
function deliverAll<T>(
  topic: string,
  listeners: ReadonlySet<(value: T, cursor: number) => void>,
  value: T,
): void {
  act(() => {
    if (listeners.size === 0)
      throw new Error(`the ${topic} topic is not subscribed`);
    for (const on of listeners) on(value, 1);
  });
}

/** Subscribes into `listeners`; the unsubscribe removes only that one. */
const subscribeInto =
  <T>(listeners: Set<T>) =>
  (on: T) => {
    listeners.add(on);
    return () => {
      listeners.delete(on);
    };
  };

/**
 * A feed whose snapshot topics (fleet, inbox, pulses, spend, gates) and `tickets` the test pushes by
 * hand. Every topic holds several listeners, since the header, a view, its tabs and the activity
 * panel subscribe to them (an IDE's Reviews view and a ticket tab both follow `gates`).
 */
export function pushFeed() {
  const fleet = new Set<OnFleet>();
  const inbox = new Set<OnInbox>();
  const pulses = new Set<OnPulses>();
  const tickets = new Set<OnTicketEvents>();
  const spend = new Set<OnSpend>();
  const gates = new Set<OnGates>();
  const feed: Feed = {
    ...silentFeed,
    subscribeFleet: subscribeInto(fleet),
    subscribeInbox: subscribeInto(inbox),
    subscribePulses: subscribeInto(pulses),
    subscribeTickets: subscribeInto(tickets),
    subscribeSpend: subscribeInto(spend),
    subscribeGates: subscribeInto(gates),
  };
  return {
    feed,
    pushFleet: (next: Fleet) => deliverAll("fleet", fleet, next),
    pushInbox: (page: InboxPage) => deliverAll("inbox", inbox, page),
    pushPulses: (page: PulsesPage) => deliverAll("pulses", pulses, page),
    pushTickets: (events: readonly TicketEventView[]) =>
      deliverAll("tickets", tickets, [...events]),
    pushSpend: (summary: SpendSummary) => deliverAll("spend", spend, summary),
    pushGates: (page: GatesPage) => deliverAll("gates", gates, page),
  };
}
