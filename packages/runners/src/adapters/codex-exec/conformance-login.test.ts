// A login granted in place, through the conformance harness on codex-exec's stand-in CLI (§14,
//). The harness hands the adapter SpawnSpec.grantedLogin exactly as a session's spawn
// does, so the adapter's own per-turn write-back returns a rotation to the operator's file, and the
// harness's read at the next process start hands the next session the rotated login. A value read
// once at the run's start would hand it the one the rotation retired, which the provider refuses.
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, systemClock } from "@bayon/core";
import { LocalExecutor, SlotCounter, readLiveLogin } from "@bayon/executors";
import { afterEach, expect, test, vi } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { SuiteCtx, type Live } from "../../conformance/harness.js";
import { createReferencePorts } from "../../conformance/reference.js";
import {
  OFFLINE_BUDGETS,
  type Budgets,
  type ConformanceSubject,
} from "../../conformance/types.js";
import { createCodexExecAdapter } from "./adapter.js";
import { CODEX_EXEC_KIT } from "./conformance.js";
import { CODEX_DIR } from "./home.js";
import { STUB_CODEX } from "./testing/stub.js";

const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 10_000,
  turnMs: 10_000,
  graceMs: 500,
};
const GRANTED =
  '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-1","id_token":"i-1"},"last_refresh":"2026-09-15T00:00:00Z"}';
const ROTATED =
  '{"OPENAI_API_KEY":null,"tokens":{"refresh_token":"r-2","id_token":"i-2"},"last_refresh":"2026-09-21T00:00:00Z"}';

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The operator's login, 0600, as `codex login` leaves it. */
function grantedFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-cf-granted-")));
  roots.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, GRANTED, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** The supervisor's reader, as far as this package can see it: the granted file, read now. */
const readGrant =
  (path: string): NonNullable<ConformanceSubject["grantedLogin"]> =>
  async () => {
    const login = readLiveLogin(path);
    return login.ok
      ? ok({ path, value: login.value.text, mode: login.value.mode })
      : login;
  };

/** The digest of the auth.json the stand-in found in `live`'s home on its first turn. */
function handedOnFirstTurn(live: Live): string | undefined {
  const file = join(live.dirs.homeDir, CODEX_DIR, "stub", "env-0.json");
  const creds = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    string
  >;
  return creds["auth.json"];
}

test(
  "a conformance session's rotation is written back to the granted file, and the next session starts from it",
  { timeout: 60_000 },
  async () => {
    const path = grantedFile();
    const fault = new FaultExecutor(
      new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
    );
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    const ctx = new SuiteCtx(
      {
        adapter: createCodexExecAdapter({
          bin: [process.execPath, STUB_CODEX],
          graceMs: BUDGETS.graceMs,
        }),
        kit: CODEX_EXEC_KIT,
        model: CHEAP_MODEL,
        executor: fault,
        // No credential in the env: the grant is the only one (the stand-in rotates what it finds).
        env: {
          PATH: process.env["PATH"] ?? "",
          FRM_STUB_REFRESH_AUTH: ROTATED,
        },
        grantedLogin: readGrant(path),
      },
      ports,
      BUDGETS,
    );
    try {
      const a = await ctx.open({ scenario: "plain" });
      await a.spawn();
      expect((await a.run(a.turn(0))).watch.by).toBe("terminal");
      expect(handedOnFirstTurn(a)).toBe(digest(GRANTED));
      // The adapter's per-turn write-back, unchanged: the file holds the rotation before any stop.
      await vi.waitFor(() => expect(readFileSync(path, "utf8")).toBe(ROTATED), {
        timeout: 10_000,
        interval: 20,
      });
      await ctx.close(a);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const b = await ctx.open({ scenario: "plain" });
      await b.spawn();
      expect((await b.run(b.turn(0))).watch.by).toBe("terminal");
      expect(handedOnFirstTurn(b)).toBe(digest(ROTATED));
      expect(await ctx.teardown()).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(ROTATED);
    } finally {
      await fault.end(systemClock, BUDGETS.callMs);
      await ports.workspace.dispose();
    }
  },
);
