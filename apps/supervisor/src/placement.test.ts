// Executors from their rows: the local executor always; each enabled container
// row built with its id, slots and config, the runners' egress hosts and the supervisor's /mcp; the
// rest logged and skipped, so admission refuses them as "not loaded".
import { FakeClock } from "@bayon/core";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter, type ContainerExecutorOptions } from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { loadAdapter, RUNNER_IDS, type RunnerAdapter } from "@bayon/runners";
import { afterAll, expect, test } from "vitest";
import type { Log } from "./lifecycle/context.js";
import { createPlacement, egressHostsOf } from "./placement.js";

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

function logger() {
  const lines: { readonly level: string; readonly msg: string }[] = [];
  const at =
    (level: string) =>
    (_obj: object, msg: string): void => {
      lines.push({ level, msg });
    };
  const log: Log = { info: at("info"), warn: at("warn"), error: at("error") };
  return { lines, log };
}

test("loads the local executor and each enabled container row that builds; skips the rest", async () => {
  const t = unwrap(await tempDb(new FakeClock(0)));
  cleanups.push(() => t.cleanup());
  unwrap(
    await seedRows(t.db, {
      executors: [
        { id: "local", kind: "local", config_json: "{}" },
        {
          id: "ctr-a",
          kind: "container",
          config_json: JSON.stringify({ remote_root: "/r" }),
          slots: 3,
          trust: "untrusted",
        },
        { id: "ctr-off", kind: "container", config_json: "{}", enabled: 0 },
        { id: "ctr-bad", kind: "container", config_json: "{" },
        { id: "rem-1", kind: "remote", config_json: "{}" },
      ],
    }),
  );
  const calls: ContainerExecutorOptions[] = [];
  const closed: string[] = [];
  const localSlots = new SlotCounter(4);
  const local = {
    executor: new FakeExecutor({
      id: "local",
      slots: localSlots,
      programs: {},
    }),
    slots: localSlots,
  };
  const { lines, log } = logger();
  const placement = createPlacement({
    frmHome: "/frm",
    mcpUrl: "http://127.0.0.1:3010/mcp",
    local,
    egressHosts: ["api.example.com"],
    log,
    container: (o) => {
      calls.push(o);
      if (o.id === "ctr-bad") throw new Error("invalid config_json");
      return Object.assign(
        new FakeExecutor({ id: o.id, slots: o.slots, programs: {} }),
        {
          close: async () => {
            closed.push(o.id);
          },
        },
      );
    },
  });
  expect([...placement.loaded().keys()]).toEqual(["local"]);
  const loaded = unwrap(await placement.load(t.db));
  expect([...loaded.keys()].toSorted()).toEqual(["ctr-a", "local"]);
  expect(loaded.get("local")).toBe(local);
  expect(calls.map((c) => c.id).toSorted()).toEqual(["ctr-a", "ctr-bad"]);
  const built = calls.find((c) => c.id === "ctr-a");
  expect(built).toMatchObject({
    frmHome: "/frm",
    config: { remote_root: "/r" },
    egressHosts: ["api.example.com"],
    mcpUrl: "http://127.0.0.1:3010/mcp",
  });
  expect(built?.slots.capacity()).toEqual({ slots: 3, used: 0 });
  // Unparseable config_json reaches the executor as {}: its own schema refuses it.
  expect(calls.find((c) => c.id === "ctr-bad")?.config).toEqual({});
  expect(lines).toEqual(
    expect.arrayContaining([
      {
        level: "error",
        msg: "cannot build the executor from its row: admission refuses it",
      },
      {
        level: "warn",
        msg: "no executor of this kind runs here yet: admission refuses it",
      },
    ]),
  );
  await placement.close();
  expect(closed).toEqual(["ctr-a"]);
  expect([...placement.loaded().keys()]).toEqual(["local"]);
});

test("egressHostsOf merges every adapter's defaults, sorted and without duplicates", () => {
  const adapters = new Map<string, RunnerAdapter>();
  for (const id of RUNNER_IDS) {
    const adapter = loadAdapter(id);
    if (adapter.ok) adapters.set(id, adapter.value);
  }
  const hosts = egressHostsOf(adapters);
  expect(hosts.length).toBeGreaterThan(0);
  expect(hosts).toEqual([...new Set(hosts)].toSorted());
  expect(egressHostsOf(new Map())).toEqual([]);
});
