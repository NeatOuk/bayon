import { describe, expect, test } from "vitest";
import { containerReadiness, containerRefusal } from "./container-ready.js";

describe("containerReadiness", () => {
  test("an install line and no reason: ready", () => {
    expect(
      containerReadiness({ containerInstall: ["npm i -g x@1"], other: 1 }),
    ).toEqual({ ready: true });
  });

  test("a declared reason wins over an install line", () => {
    expect(
      containerReadiness({
        containerInstall: ["npm i -g x@1"],
        containerUnready: "it starts this host's node",
      }),
    ).toEqual({ ready: false, reason: "it starts this host's node" });
  });

  test("no install line, no defaults, or defaults that are not JSON: not ready", () => {
    for (const defaults of [{}, { containerInstall: [] }, undefined, null]) {
      expect(containerReadiness(defaults)).toEqual({
        ready: false,
        reason: "it has no containerInstall line, so no image holds it",
      });
    }
  });

  test("container fields of the wrong shape: not ready, and says so", () => {
    for (const defaults of [
      { containerInstall: "npm i -g x@1" },
      { containerInstall: ["ok"], containerUnready: "" },
      "text",
    ]) {
      const r = containerReadiness(defaults);
      expect(r.ready).toBe(false);
      expect(r.ready ? "" : r.reason).toMatch(/do not parse/);
    }
  });
});

describe("containerRefusal", () => {
  const check = {
    runnerId: "r1",
    executorId: "ctr-1",
    defaults: { containerUnready: "no image holds its CLI" },
  };

  test("an unready runner on a container: validation, not retryable, naming runner, executor and reason", () => {
    expect(containerRefusal({ ...check, executorKind: "container" })).toEqual({
      class: "validation",
      message:
        "runner r1 cannot run on container executor ctr-1: no image holds its CLI",
      retryable: false,
      cause: {
        rule: "container_ready",
        runner: "r1",
        executor: "ctr-1",
        reason: "no image holds its CLI",
      },
    });
  });

  test("any runner on an executor that is not a container, and a ready runner on one: no refusal", () => {
    expect(containerRefusal({ ...check, executorKind: "local" })).toBeNull();
    expect(
      containerRefusal({
        ...check,
        defaults: { containerInstall: ["npm i -g x@1"] },
        executorKind: "container",
      }),
    ).toBeNull();
  });
});
