// A hand-off row → its packet bytes, path and hash. The db writers call the
// render inside their transaction; the bytes then go to the worktree after the commit.
import { createHash } from "node:crypto";
import {
  renderPacket,
  type HandoffFacts,
  type HandoffQuality,
  type Judgement,
} from "@bayon/core";
import type { HandoffRow } from "@bayon/db";
import type { RenderedPacket } from "@bayon/db/supervisor";
import { z } from "zod";
import type { Ctx } from "./context.js";

export const packetPath = (n: number): string => `.foreman/handoff-${n}.md`;

const NUMBER = /handoff-(\d+)\.md$/;
export const packetNumber = (row: Pick<HandoffRow, "packet_path">): number =>
  Number(NUMBER.exec(row.packet_path)?.[1] ?? 0);

export interface RenderedText extends RenderedPacket {
  readonly text: string;
}

export interface RenderInput {
  /** The row's id: the header shows it. */
  readonly id: string;
  readonly n: number;
  readonly reason: string;
  readonly phase: string | null;
  /**
   * The phase the successor takes up, when this hand-off ends one; absent, the header
   * reads `<phase> → <phase>`, as it does for a ceiling, where nothing changed phase.
   */
  readonly phaseTo?: string | null | undefined;
  readonly quality: HandoffQuality;
  readonly facts: HandoffFacts;
  readonly judgement: Judgement | null;
  readonly verified: boolean;
  readonly why: string;
}

export function renderRow(ctx: Ctx, i: RenderInput): RenderedText {
  const phase = i.phase ?? i.facts.session.run_class;
  const packet = renderPacket(
    {
      key: i.facts.ticket.key,
      id: i.id,
      n: i.n,
      phaseFrom: phase,
      phaseTo: i.phaseTo ?? phase,
      reason: i.reason,
      quality: i.quality,
    },
    i.facts,
    i.judgement,
    {
      verified: i.verified,
      why: i.why,
      capTokens: ctx.settings["handoff.packet_tokens_cap"],
    },
  );
  return {
    text: packet.text,
    packet_path: packetPath(i.n),
    packet_hash: createHash("sha256").update(packet.text).digest("hex"),
    tokens_est: packet.tokens_est,
  };
}

const Pointers = z.array(z.string());

/** The row's judgement half, or null when the agent wrote none. */
export function judgementOf(row: HandoffRow): Judgement | null {
  if (row.goal_line === null) return null;
  const pointers = Pointers.safeParse(
    row.pointers_json === null ? [] : parseJson(row.pointers_json),
  );
  return {
    goal_line: row.goal_line,
    decisions_md: row.decisions_md,
    traps_md: row.traps_md,
    next_steps_md: row.next_steps_md,
    open_questions_md: row.open_questions_md,
    pointers: pointers.success ? pointers.data : [],
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
