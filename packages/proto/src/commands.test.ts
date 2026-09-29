import { describe, expect, test } from "vitest";
import {
  AttachRequest,
  COMMAND_TYPES,
  Command,
  CommandAccepted,
  IDEMPOTENCY_HEADER,
  IdempotencyKey,
  SessionAttachPayload,
  SessionSpawnPayload,
  SessionStopPayload,
  SpawnRequest,
  StopRequest,
} from "./commands.js";

const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const spawn = {
  session_id: "01J0SESSION",
  agent_id: "01J0AGENT",
  role: "build",
  run_class: "build",
};

describe("contract 6 commands", () => {
  test("session.spawn needs agent, role and run class; the rest is optional", () => {
    expect(SessionSpawnPayload.parse(spawn)).toEqual(spawn);
    const full = {
      ...spawn,
      workspace_id: "W",
      ticket_id: "T",
      runner_id: "fixture",
      executor_id: "local",
      prompt: "Fix the README typo.",
    };
    expect(SessionSpawnPayload.parse(full)).toEqual(full);
    for (const key of ["session_id", "agent_id", "role", "run_class"]) {
      expect(SessionSpawnPayload.safeParse(omit(spawn, key)).success).toBe(
        false,
      );
    }
    expect(SessionSpawnPayload.safeParse({ ...spawn, role: "" }).success).toBe(
      false,
    );
  });

  test("session.stop takes graceful or kill", () => {
    for (const mode of ["graceful", "kill"]) {
      expect(SessionStopPayload.parse({ session_id: "S", mode })).toEqual({
        session_id: "S",
        mode,
      });
    }
    expect(
      SessionStopPayload.safeParse({ session_id: "S", mode: "nicely" }).success,
    ).toBe(false);
  });

  test("Command is a union on type with one payload per type", () => {
    expect(COMMAND_TYPES).toEqual([
      "session.spawn",
      "session.interrupt",
      "session.stop",
      "export.run",
      "session.handoff",
      "pulse.run",
      "pulse.report",
      "probe.run",
      "gate.run",
      "runner.conformance",
      "executor.health",
      "session.attach",
      "session.detach",
    ]);
    // an executor's health check names the executor, nothing else.
    expect(
      Command.parse({
        type: "executor.health",
        payload: { executor_id: "ctr-lab" },
      }),
    ).toEqual({ type: "executor.health", payload: { executor_id: "ctr-lab" } });
    expect(
      Command.safeParse({ type: "executor.health", payload: {} }).success,
    ).toBe(false);
    // the API mints the reviewer's session id with the gate; both are required.
    const gateRun = { gate_id: "G1", session_id: "S1" };
    expect(Command.parse({ type: "gate.run", payload: gateRun })).toEqual({
      type: "gate.run",
      payload: gateRun,
    });
    expect(
      Command.safeParse({ type: "gate.run", payload: { gate_id: "G1" } })
        .success,
    ).toBe(false);
    // a report directory is absolute, on the supervisor's host.
    expect(
      Command.parse({
        type: "runner.conformance",
        payload: {
          runner_id: "R",
          executor_id: "local",
          model_id: "R.cheap",
          report_dir: "/r",
        },
      }).type,
    ).toBe("runner.conformance");
    // a run certifies one model, so it names one.
    expect(
      Command.safeParse({
        type: "runner.conformance",
        payload: { runner_id: "R", executor_id: "local", report_dir: "/r" },
      }).success,
    ).toBe(false);
    expect(
      Command.safeParse({
        type: "runner.conformance",
        payload: {
          runner_id: "R",
          executor_id: "local",
          model_id: "R.cheap",
          report_dir: "rel",
        },
      }).success,
    ).toBe(false);
    expect(Command.parse({ type: "session.spawn", payload: spawn })).toEqual({
      type: "session.spawn",
      payload: spawn,
    });
    expect(
      Command.parse({
        type: "session.interrupt",
        payload: { session_id: "S" },
      }),
    ).toEqual({ type: "session.interrupt", payload: { session_id: "S" } });
    expect(
      Command.safeParse({ type: "session.kill", payload: { session_id: "S" } })
        .success,
    ).toBe(false);
    expect(
      Command.safeParse({ type: "session.stop", payload: { session_id: "S" } })
        .success,
    ).toBe(false);
    expect(Command.parse({ type: "export.run", payload: {} })).toEqual({
      type: "export.run",
      payload: {},
    });
  });

  test("session.spawn takes an optional handoff_id; POST /sessions refuses one", () => {
    expect(SessionSpawnPayload.parse({ ...spawn, handoff_id: "H" })).toEqual({
      ...spawn,
      handoff_id: "H",
    });
    expect(
      SpawnRequest.safeParse({ ...omit(spawn, "session_id"), handoff_id: "H" })
        .success,
    ).toBe(false);
  });

  test("the M2 commands: session.handoff, pulse.run, pulse.report and probe.run", () => {
    for (const command of [
      {
        type: "session.handoff",
        payload: { session_id: "S", reason: "agent_request", note: "stuck" },
      },
      {
        type: "session.handoff",
        payload: { session_id: "S", reason: "operator" },
      },
      { type: "pulse.run", payload: { agent_id: "A" } },
      {
        type: "pulse.report",
        payload: {
          pulse_id: "P",
          session_id: "S",
          summary_md: "Staffed one ticket.",
          actions: ["staffed #12 as builder"],
        },
      },
      { type: "probe.run", payload: { pulse_id: "P", probe: "log_scan" } },
    ]) {
      expect(Command.parse(command)).toEqual(command);
    }
    for (const bad of [
      {
        type: "session.handoff",
        payload: { session_id: "S", reason: "tired" },
      },
      { type: "session.handoff", payload: { reason: "operator" } },
      { type: "pulse.run", payload: {} },
      {
        type: "pulse.report",
        payload: {
          pulse_id: "P",
          session_id: "S",
          summary_md: "",
          actions: [],
        },
      },
      {
        type: "pulse.report",
        payload: {
          pulse_id: "P",
          session_id: "S",
          summary_md: "s",
          actions: Array<string>(21).fill("a"),
        },
      },
      { type: "probe.run", payload: { pulse_id: "P" } },
    ]) {
      expect(Command.safeParse(bad).success).toBe(false);
    }
  });
});

describe("REST bodies", () => {
  test("POST /sessions is the spawn payload without a session id, strictly", () => {
    const body = omit(spawn, "session_id");
    expect(SpawnRequest.parse({ ...body, prompt: "go" })).toEqual({
      ...body,
      prompt: "go",
    });
    expect(SpawnRequest.safeParse(spawn).success).toBe(false);
    expect(SpawnRequest.safeParse({ ...body, runclass: "x" }).success).toBe(
      false,
    );
  });

  test("POST /sessions/:id/stop defaults to a graceful stop", () => {
    expect(StopRequest.parse(undefined)).toEqual({ mode: "graceful" });
    expect(StopRequest.parse({})).toEqual({ mode: "graceful" });
    expect(StopRequest.parse({ mode: "kill" })).toEqual({ mode: "kill" });
    expect(StopRequest.safeParse({ mode: "soft" }).success).toBe(false);
  });

  test("POST /sessions/:id/attach takes the session now unless it asks to wait for the turn's end", () => {
    expect(AttachRequest.parse(undefined)).toEqual({ when: "now" });
    expect(AttachRequest.parse({ client_token: "tab-1" })).toEqual({
      client_token: "tab-1",
      when: "now",
    });
    expect(AttachRequest.parse({ when: "turn_end" })).toEqual({
      when: "turn_end",
    });
    expect(AttachRequest.safeParse({ when: "later" }).success).toBe(false);
    expect(AttachRequest.safeParse({ when: "now", x: 1 }).success).toBe(false);
    // The command's own `when` is optional: a row stored before an earlier change still parses, as `now`.
    expect(SessionAttachPayload.parse({ session_id: "S1" })).toEqual({
      session_id: "S1",
    });
    expect(
      SessionAttachPayload.parse({ session_id: "S1", when: "turn_end" }),
    ).toEqual({ session_id: "S1", when: "turn_end" });
    expect(
      SessionAttachPayload.safeParse({ session_id: "S1", when: "soon" })
        .success,
    ).toBe(false);
  });

  test("an Idempotency-Key is 1 to 255 characters", () => {
    expect(IDEMPOTENCY_HEADER).toBe("Idempotency-Key");
    expect(IdempotencyKey.safeParse("k").success).toBe(true);
    expect(IdempotencyKey.safeParse("").success).toBe(false);
    expect(IdempotencyKey.safeParse("k".repeat(256)).success).toBe(false);
  });

  test("a command is accepted with its id, the session and whether it is new", () => {
    const accepted = { command_id: "C", session_id: "S", created: true };
    expect(CommandAccepted.parse(accepted)).toEqual(accepted);
  });
});
