// §15 #10 unknown event tolerance (non-negotiable): a generic unknown line and the kit's
// runner-shaped nested unknowns, injected after the run's first record, are each stored exactly
// once as `runner_native`; ingest keeps going and the run ends on its own terminal (Invariant 4).
import type { StoredEvent } from "../types.js";
import { check, define, endedWith, outcomeOf } from "./define.js";

export interface UnknownEvidence {
  /** Each injected nonce and how many injected lines carry it. */
  readonly nonces: readonly {
    readonly nonce: string;
    readonly lines: number;
  }[];
  readonly events: readonly StoredEvent[];
  readonly fatal: boolean;
}

export function judgeUnknown(e: UnknownEvidence) {
  const carries = (ev: StoredEvent, nonce: string) =>
    JSON.stringify(ev).includes(nonce);
  const counts = e.nonces.map((n) => ({
    ...n,
    seen: e.events.filter(
      (ev) => ev.kind === "runner_native" && carries(ev, n.nonce),
    ).length,
  }));
  const injectedAt = e.events.flatMap((ev, i) =>
    e.nonces.some((n) => carries(ev, n.nonce)) ? [i] : [],
  );
  // With nothing stored, the injection point is the run's first record.
  const last = injectedAt.at(-1) ?? 0;
  return [
    check(
      "unknown_stored",
      counts.every((c) => c.seen === c.lines),
      counts.map((c) => `${c.seen}/${c.lines}`).join(", "),
    ),
    check(
      "events_after_injection",
      e.events.slice(last + 1).some((ev) => ev.kind !== "runner_native"),
    ),
    check("own_terminal_ok", endedWith(e.events, "ok"), outcomeOf(e.events)),
    check("ingest_alive", !e.fatal),
  ];
}

export const t10 = define({
  id: 10,
  retries: 0,
  drive: async (ctx): Promise<UnknownEvidence> => {
    const live = await ctx.open({ scenario: "plain" });
    await live.spawn();
    const generic = ctx.vars().nonce;
    const shaped = ctx.vars().nonce;
    const lines = ctx.subject.kit.unknownLines(shaped);
    ctx.subject.executor.inject(live.dirs.cwd, [
      {
        type: "frm.conformance.unknown",
        kind: "frm.conformance.unknown",
        nonce: generic,
      },
      ...lines,
    ]);
    const end = await live.run(live.turn(0));
    return {
      nonces: [
        { nonce: generic, lines: 1 },
        { nonce: shaped, lines: lines.length },
      ],
      events: end.events,
      fatal: ctx.ports.ingest.fatal() !== null,
    };
  },
  judge: judgeUnknown,
});
