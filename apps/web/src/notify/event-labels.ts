import {
  NOTIFY_EVENT_KINDS,
  eventBit,
  subscribes,
  type NotifyEventKind,
} from "@bayon/core";

// What a channel's events mask says, in words. `notify.<channel>.events` is a number
// because the settings whitelist holds numbers only; nobody should have to add up bits, so the GUI
// draws one checkbox per kind and never shows the total. Exhaustive over core's kinds, so a kind
// added later fails to typecheck here instead of appearing as a bare id.

export const EVENT_LABEL: Readonly<Record<NotifyEventKind, string>> = {
  question: "Questions",
  staff_proposal: "Staffing proposals",
  qa_human: "Ready for your QA",
  ticket_blocked: "Blocked tickets",
  jira_sync_failed: "Jira sync failures",
  budget_warn: "Budget warnings",
  attention: "Needs attention",
};

export const EVENT_HELP: Readonly<Record<NotifyEventKind, string>> = {
  question: "An agent, or the watchdog, is waiting on an answer.",
  staff_proposal: "An orchestrator proposes staffing a ticket.",
  qa_human: "A ticket reached your own QA.",
  ticket_blocked: "The circuit breaker stopped work on a ticket.",
  jira_sync_failed: "A project's Jira mirror failed after one that did not.",
  budget_warn: "A budget passed its warning level.",
  attention:
    "Something stands and waits: a kept worktree, an unhealthy executor, a question over a day old, a change to these settings, a runner update.",
};

/** The kinds in the order the cards draw them: core's list, which is also the bit order. */
export const EVENT_KINDS: readonly NotifyEventKind[] = NOTIFY_EVENT_KINDS;

/** `mask` with `kind` ticked or unticked; every other kind is left where it was. */
export const withEvent = (
  mask: number,
  kind: NotifyEventKind,
  on: boolean,
): number => (on ? mask | eventBit(kind) : mask & ~eventBit(kind));

export const hasEvent = (mask: number, kind: NotifyEventKind): boolean =>
  subscribes(mask, kind);
