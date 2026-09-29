// The Seatbelt confinement. The profile's text, then
// the real thing on macOS: a session over a worktree of a bare mirror — Bayon's local layout — run
// through the real adapter, turn host and sandbox-exec, with the stand-in's shell running what the
// model would. Writes outside the worktree, into the mirror's hooks and into its config are refused
// by the kernel; an edit and a commit in the worktree work.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, describe, expect, test } from "vitest";
import type { SessionHandle, SpawnSpec } from "../../adapter.js";
import { createOpencodeAdapter } from "./adapter.js";
import { confinement, placementRefusal } from "./confine.js";
import { ProviderBlock } from "./home.js";
import { DEFAULTS } from "./registration.js";
import {
  LOOPBACK_MARK,
  byName,
  credentialStores,
  gitGuards,
  portOf,
  seatbeltProfile,
} from "./sandbox.js";
import { STUB_OPENCODE } from "./testing/stub.js";

describe("the profile", () => {
  const profile = seatbeltProfile({
    writable: ["/w/repo", "/w/home"],
    denyWrite: gitGuards(["/w/mirror.git"]),
    denyRead: ["/Users/op/.ssh"],
    providerPorts: [11434],
    dns: false,
  });

  test("writes: denied, then the worktree and home allowed, then git's config and hooks denied again", () => {
    const at = (s: string) => profile.indexOf(s);
    expect(at("(deny file-write*)")).toBeLessThan(at('(subpath "/w/repo")'));
    expect(at('(subpath "/w/repo")')).toBeLessThan(
      at('(subpath "/w/mirror.git/hooks")'),
    );
    expect(profile).toContain('(subpath "/w/mirror.git/config")');
    expect(profile).toContain('(subpath "/w/mirror.git/config.worktree")');
  });

  test("network: the session's own loopback ports (placed by the host) and the provider's port", () => {
    expect(profile).toContain("(deny network-outbound)");
    expect(profile).toContain(LOOPBACK_MARK);
    expect(profile).not.toContain('"localhost:*"');
    expect(profile).toContain(
      '(allow network-outbound (remote tcp "*:11434"))',
    );
    expect(profile).not.toContain("mDNSResponder");
    expect(portOf("http://<host>:11434/v1")).toBeUndefined();
    expect(portOf("http://10.0.0.2:11434/v1")).toBe(11434);
    expect(portOf("https://api.example.com/v1")).toBe(443);
    expect(byName("https://api.example.com/v1")).toBe(true);
    expect(byName("http://10.0.0.2:11434/v1")).toBe(false);
  });

  test("a provider port is opened to every host, never to the provider's alone: the rule names no host", () => {
    // Documents the boundary the model settings' guardrails rest on (models.ts): whatever host a
    // provider URL names, the profile carries only its port, so every host is reachable on it.
    const rules = profile
      .split("\n")
      .filter((line) => line.includes("remote tcp"));
    expect(rules).toEqual(['(allow network-outbound (remote tcp "*:11434"))']);
    expect(profile).not.toMatch(/remote tcp "(?!\*:)[^"]+"/);
    const two = seatbeltProfile({
      writable: [],
      denyWrite: [],
      denyRead: [],
      providerPorts: [portOf("http://10.0.0.7:11434/v1") ?? 0],
      dns: false,
    });
    const other = seatbeltProfile({
      writable: [],
      denyWrite: [],
      denyRead: [],
      providerPorts: [portOf("http://10.0.0.99:11434/v1") ?? 0],
      dns: false,
    });
    // Two different provider hosts on one port give the same profile.
    expect(two).toBe(other);
  });

  test("SBPL injection: a path with a quote, a backslash, a paren and a newline stays one string", () => {
    const evil = '/w/a"b\\c)d\n(allow file-write* (subpath "/"))';
    const hostile = seatbeltProfile({
      writable: [evil],
      denyWrite: [],
      denyRead: [],
      providerPorts: [],
      dns: false,
    });
    // One subpath rule, the path escaped inside it: no rule was added.
    expect(
      hostile.split("\n").filter((l) => l.startsWith("(allow file-write*")),
    ).toHaveLength(1);
    expect(hostile).toContain(`(subpath ${JSON.stringify(evil)})`);
    expect(hostile).not.toContain('\n(allow file-write* (subpath "/"))');
  });

  test("reads are refused to the operator's credential stores", () => {
    const stores = credentialStores("/Users/op");
    for (const p of [
      "/Users/op/Library/Keychains",
      "/Users/op/.ssh",
      "/Users/op/.config/gh",
      "/Users/op/.codex",
      "/Users/op/.config/opencode",
      "/Library/Keychains",
    ]) {
      expect(stores).toContain(p);
    }
  });

  test("placement: a container, or local with Seatbelt; nowhere else", () => {
    expect(placementRefusal("container", false)).toBeNull();
    expect(placementRefusal("remote", false)?.class).toBe("validation");
    expect(placementRefusal("local", false) === null).toBe(
      process.platform === "darwin",
    );
  });
});

describe.skipIf(process.platform !== "darwin")(
  "confined on this Mac (sandbox-exec)",
  { timeout: 120_000 },
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-sbx-")));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
        { cwd, encoding: "utf8" },
      ).trim();
    const mirror = join(root, "mirror.git");
    const seed = join(root, "seed");
    const wt = join(root, "wt");
    mkdirSync(seed);
    git(root, "init", "-q", "--bare", mirror);
    git(root, "init", "-q", seed);
    writeFileSync(join(seed, "add.js"), "return a - b;\n");
    git(seed, "add", ".");
    git(seed, "commit", "-qm", "init");
    git(seed, "push", "-q", mirror, "HEAD:main");
    git(mirror, "worktree", "add", "-q", wt, "main");
    const outside = join(root, "outside.txt");
    const hook = join(mirror, "hooks", "post-commit");
    const configBefore = readFileSync(join(mirror, "config"), "utf8");

    const adapter = createOpencodeAdapter({
      bin: [process.execPath, STUB_OPENCODE],
      graceMs: 300,
    });
    const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
    const spec: SpawnSpec = {
      sessionId: "01JSANDBOX",
      cwd: wt,
      homeDir: join(root, "home"),
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_AUTHOR_NAME: "agent",
        GIT_AUTHOR_EMAIL: "agent@frm",
        GIT_COMMITTER_NAME: "agent",
        GIT_COMMITTER_EMAIL: "agent@frm",
      },
      model: "ollama/gemma4:26b",
      flags: { ...DEFAULTS },
    };
    let handle: SessionHandle | undefined;
    let records: AsyncIterator<{ bytes: Uint8Array }> | undefined;

    /** One turn running `command` in the model's shell; the tool's output. */
    async function run(runId: string, command: string): Promise<string> {
      if (handle === undefined) {
        expect((await adapter.prepareHome(spec, local)).ok).toBe(true);
        const h = await adapter.spawn(spec, local);
        if (!h.ok) throw new Error(h.error.message);
        handle = h.value;
        records = adapter.records(handle)[Symbol.asyncIterator]();
      }
      const sent = await adapter.send(handle, {
        runId,
        text: `Run exactly: \`${command}\``,
        promptPath: "/p",
      });
      expect(sent.ok).toBe(true);
      const lines: string[] = [];
      for (;;) {
        const next = await records?.next();
        if (next === undefined || next.done === true) break;
        const line = new TextDecoder().decode(next.value.bytes);
        lines.push(line);
        if (line.includes('"stopReason"')) break;
      }
      return lines.filter((l) => l.includes('"rawOutput"')).join("\n");
    }

    afterAll(async () => {
      if (handle !== undefined) await adapter.stop(handle, "graceful");
    });

    test("a write outside the worktree is refused", async () => {
      const out = await run("r1", `echo x > ${outside}`);
      expect(out).toContain("Operation not permitted");
      expect(existsSync(outside)).toBe(false);
    });

    test("a hook planted in the mirror is refused", async () => {
      const out = await run(
        "r2",
        `printf '#!/bin/sh\\ntouch ${outside}\\n' > ${hook} && chmod +x ${hook}`,
      );
      expect(out).toContain("Operation not permitted");
      expect(existsSync(hook)).toBe(false);
    });

    test("an edit of the mirror's config is refused, git config or not", async () => {
      await run(
        "r3",
        `echo '[core] hooksPath = /tmp' >> ${join(mirror, "config")}`,
      );
      await run(
        "r4",
        `git --git-dir=${mirror} config --file ${join(mirror, "config")} core.hooksPath /tmp`,
      );
      expect(readFileSync(join(mirror, "config"), "utf8")).toBe(configBefore);
    });

    test("an edit and a commit in the worktree work", async () => {
      const out = await run(
        "r5",
        "sed -i '' 's/a - b/a + b/' add.js && git add add.js && git commit -qm fix && git log -1 --format=%s",
      );
      expect(out).toContain("fix");
      expect(git(mirror, "log", "-1", "--format=%s", "main")).toBe("fix");
      expect(readFileSync(join(wt, "add.js"), "utf8")).toBe("return a + b;\n");
    });

    test("the model's git runs no hook, even one the repository config names", async () => {
      // The operator-side setup a session could not have made: a hook the config points at.
      const hooks = join(root, "hooks");
      mkdirSync(hooks);
      writeFileSync(
        join(hooks, "post-commit"),
        `#!/bin/sh\ntouch ${join(wt, "HOOK-RAN")}\n`,
        {
          mode: 0o755,
        },
      );
      git(wt, "config", "core.hooksPath", hooks);
      await run("r6", "git commit -q --allow-empty -m again");
      expect(existsSync(join(wt, "HOOK-RAN"))).toBe(false);
      git(wt, "config", "--unset", "core.hooksPath");
    });

    test("SBPL injection, for real: a hostile worktree path parses, and grants nothing more", async () => {
      const dir = join(root, 'q"b\\c)d\ne');
      mkdirSync(dir);
      const hostileSpec = { ...spec, cwd: dir, homeDir: join(dir, "home") };
      const prefix = await confinement(
        local,
        hostileSpec,
        undefined,
        ProviderBlock.parse(DEFAULTS.providers.ollama),
        false,
      );
      if (!prefix.ok) throw new Error(prefix.error.message);
      const [exec, flag, profile] = prefix.value;
      // The path goes to the shell as an argument, never through its quoting.
      const write = (path: string) =>
        spawnSync(
          exec ?? "",
          [flag ?? "", profile ?? "", "/bin/sh", "-c", 'echo ok > "$0"', path],
          { cwd: dir, encoding: "utf8" },
        ).status;
      expect(write(join(dir, "in.txt"))).toBe(0);
      expect(existsSync(join(dir, "in.txt"))).toBe(true);
      const outside = join(root, "not-granted.txt");
      expect(write(outside)).not.toBe(0);
      expect(existsSync(outside)).toBe(false);
    });

    test("no outbound connection but the session's own and the provider's port", async () => {
      const server = spawn(process.execPath, [
        "-e",
        "require('node:net').createServer((s) => s.end('pong')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })",
      ]);
      const port = await new Promise<string>((resolve) =>
        server.stdout.once("data", (d: Buffer) => resolve(d.toString().trim())),
      );
      try {
        // Another loopback service (the supervisor's API, another session's proxy): refused.
        const loop = await run(
          "r7",
          `nc -w 2 127.0.0.1 ${port} </dev/null; echo exit=$?`,
        );
        expect(loop).not.toContain("pong");
        const out = await run("r8", "nc -z -w 2 1.1.1.1 443; echo exit=$?");
        expect(out).not.toContain("exit=0");
      } finally {
        server.kill();
      }
    });
  },
);
