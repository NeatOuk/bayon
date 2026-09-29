// The build-leftover scan's reuse: the scan reads every dangling image's
// history on the shared host (seconds of docker calls with another tenant's images there), so health
// reuses its answer for `leftover_scan_ms`; a fresh read or a removal of leftovers re-scans.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { SlotCounter } from "../slots.js";
import { ContainerExecutor } from "./container.js";
import { installFakeDocker } from "./fake-docker.js";
import { LoopbackTransport } from "./loopback.js";
import type { RemoteChild } from "./transport.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-leftovers-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const { env } = installFakeDocker(base, "ctr-loop");

class SpyTransport extends LoopbackTransport {
  readonly started: string[] = [];
  override start(command: string, signal: AbortSignal): Promise<RemoteChild> {
    this.started.push(command);
    return super.start(command, signal);
  }
}

test("the scan is reused for leftover_scan_ms; fresh, or after a removal, it runs again", async () => {
  const spy = new SpyTransport(env);
  const root = join(base, "remote");
  const ex = new ContainerExecutor({
    id: "ctr-loop",
    slots: new SlotCounter(1),
    frmHome: base,
    config: {
      ssh: { host: "loopback", user: "frm", identity_ref: "file:/dev/null" },
      remote_root: root,
      image: "frm/test",
      leftover_scan_ms: 3_600_000,
    },
    transport: spy,
    paths: { sessions: join(root, "work"), run: join(root, "run"), shim: "/x" },
  });
  const scans = () =>
    spy.started.filter((c) => c.includes("docker history")).length;
  const none = { labelled: [], unlabelled: [], capped: false };
  expect(await ex.buildLeftovers()).toEqual(none);
  expect(await ex.buildLeftovers()).toEqual(none);
  expect(scans()).toBe(1);
  await ex.buildLeftovers({ fresh: true });
  expect(scans()).toBe(2);
  await ex.pruneBuildLeftovers();
  await ex.buildLeftovers();
  expect(scans()).toBe(3);
});
