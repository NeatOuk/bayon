import {
  AgentPulsesPage,
  PulseDetail,
  PulsePolicy,
  PulseRunAccepted,
  PulsesPage,
  type PulsePolicyPatch,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, patchJson, postJson } from "@/api/http";

const segment = encodeURIComponent;

/** `GET /pulses`: the newest pulses of every agent, the server's default page. */
export const pulsesQuery = queryOptions({
  queryKey: ["pulses"],
  queryFn: ({ signal }) => getJson("/pulses", PulsesPage, signal),
});

/** Most recent pulses an agent's list shows (the IDE's Orchestrator view). */
export const RECENT_PULSES_LIMIT = 10;

/**
 * Every agent's own pulse list. Under `pulsesQuery`'s key, so whatever refreshes the pulses (a
 * run-now, its command settling) refreshes these too; the `pulses` topic invalidates this prefix.
 */
export const AGENT_PULSES_KEY = [...pulsesQuery.queryKey, "agent"] as const;

/** `GET /pulses?agent=&limit=`: one agent's newest pulses. */
export const agentPulsesQuery = (agentId: string) =>
  queryOptions({
    queryKey: [...AGENT_PULSES_KEY, agentId],
    queryFn: ({ signal }) =>
      getJson(
        `/pulses?${new URLSearchParams({
          agent: agentId,
          limit: String(RECENT_PULSES_LIMIT),
        }).toString()}`,
        PulsesPage,
        signal,
      ),
  });

/** Pulse details: the `pulses` topic refreshes the open one by this prefix. */
export const PULSE_KEY = ["pulse"] as const;

/** `GET /pulses/:id`: the pulse and its probe checks. */
export const pulseQuery = (id: string) =>
  queryOptions({
    queryKey: [...PULSE_KEY, id],
    queryFn: ({ signal }) =>
      getJson(`/pulses/${segment(id)}`, PulseDetail, signal),
  });

/** The next-pulse countdown is measured from the last read; this keeps it fresh between frames. */
const NEXT_PULSE_REFRESH_MS = 60_000;

/** `GET /agents/pulse-policies`: each orchestrator's policy and next scheduled pulse. */
export const pulseAgentsQuery = queryOptions({
  queryKey: ["pulse-agents"],
  queryFn: ({ signal }) =>
    getJson("/agents/pulse-policies", AgentPulsesPage, signal),
  refetchInterval: NEXT_PULSE_REFRESH_MS,
});

/** `POST /pulses/run-now` (§9.7 manual): one pulse of this orchestrator now. */
export const runPulseNow = (agentId: string): Promise<PulseRunAccepted> =>
  postJson("/pulses/run-now", { agent_id: agentId }, PulseRunAccepted);

/** `PATCH /agents/:id/pulse-policy`: only the fields in `patch` change. */
export const patchPulsePolicy = (
  agentId: string,
  patch: PulsePolicyPatch,
): Promise<PulsePolicy> =>
  patchJson(`/agents/${segment(agentId)}/pulse-policy`, patch, PulsePolicy);
