import { join } from "node:path";
import { expect, test } from "vitest";
import {
  ctrTarget,
  filesContaining,
  labels,
  newCtrRun,
  rootGuard,
  sshUnreached,
  type CtrTarget,
} from "./m3-ctr-host.js";

const target: CtrTarget = { user: "ops", host: "192.0.2.10", key: "/k" };

test("ctrTarget: FRM_CONTAINER_HOST as user@host, required; the key from FRM_CONTAINER_KEY", () => {
  expect(ctrTarget({ FRM_CONTAINER_KEY: "/k" })).toMatchObject({
    ok: false,
    error: { class: "validation", message: /FRM_CONTAINER_HOST is required/ },
  });
  expect(
    ctrTarget({
      FRM_CONTAINER_HOST: "ops@192.0.2.10",
      FRM_CONTAINER_KEY: "/k",
    }),
  ).toEqual({ ok: true, value: target });
  expect(
    ctrTarget({
      FRM_CONTAINER_HOST: "ops@build.example",
      FRM_CONTAINER_KEY: "/k2",
    }),
  ).toEqual({
    ok: true,
    value: { user: "ops", host: "build.example", key: "/k2" },
  });
  for (const bad of ["ops", "Root@h", "ops@h;rm -rf /", "@h"]) {
    expect(ctrTarget({ FRM_CONTAINER_HOST: bad })).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  }
});

test("newCtrRun: a per-run executor id, root, network and canary; the root passes its own guard", () => {
  const a = newCtrRun("ctr-lab", target, "/h");
  const b = newCtrRun("ctr-lab", target, "/h");
  if (!a.ok || !b.ok) throw new Error("newCtrRun failed");
  expect(a.value.executorId).toMatch(/^ctr-lab-[0-9a-f]{6}$/);
  expect(a.value.executorId).not.toBe(b.value.executorId);
  expect(a.value.executorId.length).toBeLessThanOrEqual(32);
  expect(a.value.root).toMatch(rootGuard("ops"));
  expect(a.value.network).toMatch(/^frm-smk-[0-9a-f]{6}$/);
  expect(a.value.canary).toMatch(/^frm-canary-[0-9a-f]{24}$/);
  expect(a.value.knownHosts).toBe(
    join("/h", "executors", a.value.executorId, "known_hosts"),
  );
  expect(labels(a.value)).toBe(
    `--filter label=frm.managed=1 --filter label=frm.executor=${a.value.executorId}`,
  );
  expect(newCtrRun("Bad_Name", target, "/h")).toMatchObject({ ok: false });
  expect(newCtrRun("x".repeat(25), target, "/h")).toMatchObject({ ok: false });
});

test("rootGuard accepts only a smoke root under the user's home", () => {
  const guard = rootGuard("ops");
  expect(guard.test("/home/ops/frm/smoke/0123456789ABCDEFGHJKMNPQRS")).toBe(
    true,
  );
  for (const bad of [
    "/home/ops/frm",
    "/home/ops/frm/smoke",
    "/home/ops/frm/smoke/../..",
    "/home/other/frm/smoke/0123456789ABCDEFGHJKMNPQRS",
    "/home/ops/frm/test/0123456789ABCDEFGHJKMNPQRS",
  ])
    expect(guard.test(bad)).toBe(false);
});

test("sshUnreached: only an ssh that never reached a shell is retried", () => {
  for (const unreached of [
    "ssh 192.0.2.10: exit 255: kex_exchange_identification: read: Connection reset by peer",
    "ssh h: exit 255: ssh: connect to host h port 22: Connection refused",
    "ssh h: exit 255: ssh: connect to host h port 22: Operation timed out",
  ])
    expect(sshUnreached(unreached)).toBe(true);
  for (const reached of [
    "ssh h: exit 1: grep: /x: No such file or directory",
    "ssh h: exit 255: Connection to h closed by remote host.",
    "ssh h: killed by SIGKILL after 120000 ms",
  ])
    expect(sshUnreached(reached)).toBe(false);
});

test("filesContaining refuses a dir that is not a plain path inside the run's root, before any ssh", async () => {
  const run = newCtrRun("ctr-lab", target, "/h");
  if (!run.ok) throw new Error("newCtrRun failed");
  const { root } = run.value;
  for (const dir of [
    `${root}/work/$(id)`,
    `${root}/../other`,
    `${root}x`,
    "/home/ops/frm",
  ])
    expect(await filesContaining(run.value, dir, "needle")).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
});
