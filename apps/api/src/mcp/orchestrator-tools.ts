// The orchestrator's own tools (§11.1, M2): ticket_staff through the tickets module's staffing
// (amendment h), and pulse_report / probe_run, which only insert commands because pulses is the
// supervisor's table (§9.5). Their pulse is the caller's own, found by its session: the model never
// names one.
import { LIVE_PULSE_STATES } from "@bayon/db";
import { MCP_INPUTS } from "@bayon/proto";
import { resolveTicket } from "./ticket-ref.js";
import { fromService } from "./ticket-tools.js";
import {
  done,
  failed,
  refused,
  type Handler,
  type ToolCtx,
  type ToolOutcome,
} from "./tool-kit.js";

const LIVE = new Set<string>(LIVE_PULSE_STATES);

const ticketStaff: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.ticket_staff.parse(raw);
  if (ctx.tickets === undefined) {
    return failed({
      class: "internal",
      message: "the tickets module is not mounted",
      retryable: false,
    });
  }
  const target = await resolveTicket(ctx, input.ticket);
  if (!target.ok) return target.outcome;
  const { id, num } = target.target;
  const staffed = await ctx.tickets.staff(
    String(num),
    {
      role: input.role,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    },
    { kind: "orchestrator", sessionId: ctx.session.id },
    // One session staffs a ticket in a role (with a named agent) once, however often it asks.
    `mcp.ticket_staff:${ctx.session.id}:${id}:${input.role}${input.agent === undefined ? "" : `:${input.agent}`}`,
    ctx.audit("ticket", id),
  );
  if (!staffed.ok) return fromService(staffed.error);
  if (staffed.value.kind === "refused") {
    const { reason, detail, proposal } = staffed.value;
    // Not an error: the proposal is the outcome a project that requires approval gives.
    if (reason === "approval_pending") {
      return proposal === undefined
        ? failed({
            class: "internal",
            message: "approval_pending without its proposal",
            retryable: false,
          })
        : done(proposal);
    }
    return refused({ reason, rule: "staff", detail });
  }
  const a = staffed.value.accepted;
  return done({
    command_id: a.command_id,
    session_id: a.session_id,
    created: a.created,
    agent_id: a.agent_id,
    run_class: a.run_class,
    handoff_id: a.handoff_id,
    ticket_status: a.ticket_status,
  });
};

type OwnPulse =
  | { readonly ok: true; readonly pulseId: string }
  | { readonly ok: false; readonly outcome: ToolOutcome };

/** The caller's live pulse, or the refusal that says why it has none. */
async function ownPulse(ctx: ToolCtx): Promise<OwnPulse> {
  const pulse = await ctx.store.pulseOfSession(ctx.session.id);
  if (!pulse.ok) return { ok: false, outcome: failed(pulse.error) };
  if (pulse.value === null) {
    return {
      ok: false,
      outcome: refused({
        reason: "not_found",
        detail: "this session runs no pulse",
      }),
    };
  }
  if (!LIVE.has(pulse.value.state)) {
    return {
      ok: false,
      outcome: refused({
        reason: "illegal_transition",
        detail: `pulse ${pulse.value.id} is ${pulse.value.state}`,
      }),
    };
  }
  return { ok: true, pulseId: pulse.value.id };
}

/** Inserted before the reply, so it exists before the session's terminal. */
const pulseReport: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.pulse_report.parse(raw);
  const pulse = await ownPulse(ctx);
  if (!pulse.ok) return pulse.outcome;
  const inserted = await ctx.store.insertCommand(
    {
      type: "pulse.report",
      payload: {
        pulse_id: pulse.pulseId,
        session_id: ctx.session.id,
        summary_md: input.summary_md,
        actions: input.actions,
      },
    },
    ctx.audit("pulse", pulse.pulseId),
  );
  return inserted.ok
    ? done({ command_id: inserted.value.id, pulse_id: pulse.pulseId })
    : failed(inserted.error);
};

const probeRun: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.probe_run.parse(raw);
  const pulse = await ownPulse(ctx);
  if (!pulse.ok) return pulse.outcome;
  const enabled = await ctx.store.probeEnabled(input.probe);
  if (!enabled.ok) return failed(enabled.error);
  if (enabled.value !== true) {
    return refused({
      reason: "not_found",
      detail: `no enabled probe ${input.probe}`,
    });
  }
  const inserted = await ctx.store.insertCommand(
    {
      type: "probe.run",
      payload: { pulse_id: pulse.pulseId, probe: input.probe },
    },
    ctx.audit("pulse", pulse.pulseId),
  );
  return inserted.ok
    ? done({
        command_id: inserted.value.id,
        pulse_id: pulse.pulseId,
        probe: input.probe,
      })
    : failed(inserted.error);
};

export const ORCHESTRATOR_HANDLERS: Readonly<Partial<Record<string, Handler>>> =
  {
    ticket_staff: ticketStaff,
    pulse_report: pulseReport,
    probe_run: probeRun,
  };
