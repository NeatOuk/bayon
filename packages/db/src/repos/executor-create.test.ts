import { FakeClock } from "@bayon/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { listAudit, tempDb, unwrap, type TempDb } from "../testing.js";
import { getExecutor } from "./config.js";
import { listExecutors } from "./registry-reads.js";
import { createExecutor, type NewExecutor } from "./executor-create.js";

let t: TempDb;
beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
});
afterEach(() => t.cleanup());

function newExecutor(o: Partial<NewExecutor> = {}): NewExecutor {
  return {
    id: "ctr-demo",
    host: "192.0.2.10",
    user: "ops",
    network: "frm-internal",
    slots: 2,
    row: {
      id: "ctr-demo",
      kind: "container",
      config_json: JSON.stringify({
        ssh: {
          host: "192.0.2.10",
          user: "ops",
          identity_ref: "file:/keys/id_ed25519",
          known_hosts: "/home/frm/executors/ctr-demo/known_hosts",
        },
        remote_root: "/home/ops/frm",
        image: "node:22-bookworm-slim",
        network: "frm-internal",
        egress_allow: [],
      }),
      slots: 2,
      egress_policy: "allowlist",
      trust: "untrusted",
    },
    ...o,
  };
}

test("writes exactly one executors row plus one audit_log row, in one transaction", async () => {
  const written = await createExecutor(t.db, newExecutor());
  expect(written.ok).toBe(true);

  const row = unwrap(await getExecutor(t.db, "ctr-demo"));
  expect(row).toMatchObject({
    kind: "container",
    trust: "untrusted",
    egress_policy: "allowlist",
    slots: 2,
  });
  expect(JSON.parse(row.config_json)).toMatchObject({
    ssh: { host: "192.0.2.10", user: "ops" },
    remote_root: "/home/ops/frm",
  });

  const audit = unwrap(await listAudit(t.db));
  expect(audit).toHaveLength(1);
  const [entry] = audit;
  expect(entry).toMatchObject({
    actor: "operator",
    action: "executor.create",
    target_kind: "executor",
    target_id: "ctr-demo",
  });
  // Never identity_ref, or any other hint of key location, in the audit payload.
  expect(JSON.parse(entry?.payload_json ?? "null")).toEqual({
    via: "rest",
    host: "192.0.2.10",
    user: "ops",
    network: "frm-internal",
    slots: 2,
  });
});

test("a duplicate id is conflict; nothing is written", async () => {
  unwrap(await createExecutor(t.db, newExecutor()));
  const countBefore = unwrap(await listExecutors(t.db)).length;
  const auditCountBefore = unwrap(await listAudit(t.db)).length;

  const again = await createExecutor(t.db, newExecutor({ host: "192.0.2.20" }));
  expect(again.ok).toBe(false);
  if (!again.ok) expect(again.error.class).toBe("conflict");
  expect(unwrap(await listExecutors(t.db))).toHaveLength(countBefore);
  expect(unwrap(await listAudit(t.db))).toHaveLength(auditCountBefore);
  // The first row's host is unchanged: a failed second insert never partially overwrote it.
  expect(
    JSON.parse(unwrap(await getExecutor(t.db, "ctr-demo")).config_json).ssh
      .host,
  ).toBe("192.0.2.10");
});
