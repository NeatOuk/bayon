import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// The shell side of the deployment: secrets.sh against a temp root
// (chown stubbed out), bayon.sh against a recording ssh stand-in, the git credential helper and
// migrate.sh's lock refusal. A sentinel value is fed in everywhere: no output may ever carry it.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SENTINEL = "s3ntinel-value-0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frm-deploy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Ran {
  readonly status: number | null;
  readonly out: string;
}

function run(
  script: string,
  args: readonly string[],
  o: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
  } = {},
): Ran {
  const r = spawnSync("bash", [join(HERE, script), ...args], {
    encoding: "utf8",
    input: o.input ?? "",
    env: { PATH: process.env.PATH ?? "", HOME: dir, ...o.env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const modeOf = (path: string): string =>
  (statSync(path).mode & 0o777).toString(8).padStart(4, "0");

describe("secrets.sh", () => {
  const env = () => ({
    BAYON_ROOT: join(dir, "srv"),
    BAYON_CHOWN: "true",
    BAYON_TTY: join(dir, "tty"),
    BAYON_AUTHORIZED_KEYS: join(dir, "home", ".ssh", "authorized_keys"),
    BAYON_DOCKER: join(dir, "docker"),
  });
  const secrets = (p: string, s = "") => join(dir, "srv", p, "secrets", s);

  test("init makes the root 0700 and one 0750 directory per service", () => {
    expect(
      run("secrets.sh", ["init", "bayon-stg"], { env: env() }).status,
    ).toBe(0);
    expect(modeOf(secrets("bayon-stg"))).toBe("0700");
    for (const s of ["api", "web", "supervisor", "migrate"])
      expect(modeOf(secrets("bayon-stg", s))).toBe("0750");
  });

  test("put stores stdin as 0440 (0400 when app-owned) and never prints the value", () => {
    run("secrets.sh", ["init", "bayon"], { env: env() });
    const put = run(
      "secrets.sh",
      ["put", "bayon", "supervisor", "FRM_GIT_TOKEN"],
      {
        env: env(),
        input: SENTINEL,
      },
    );
    expect(put.status).toBe(0);
    expect(put.out).not.toContain(SENTINEL);
    const file = join(secrets("bayon", "supervisor"), "FRM_GIT_TOKEN");
    expect(readFileSync(file, "utf8")).toBe(SENTINEL);
    expect(modeOf(file)).toBe("0440");
    run("secrets.sh", ["put", "bayon", "supervisor", "OWNED", "--app-owned"], {
      env: env(),
      input: SENTINEL,
    });
    expect(modeOf(join(secrets("bayon", "supervisor"), "OWNED"))).toBe("0400");
  });

  test.each([
    [["put", "bayon", "supervisor", "EMPTY"], ""],
    [["put", "shiva", "supervisor", "X"], SENTINEL],
    [["put", "bayon", "db", "X"], SENTINEL],
    [["put", "bayon", "api", "../escape"], SENTINEL],
    [["put", "bayon", "api", ".hidden"], SENTINEL],
  ])("refuses %j", (args, input) => {
    run("secrets.sh", ["init", "bayon"], { env: env() });
    const r = run("secrets.sh", args, { env: env(), input });
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain(SENTINEL);
  });

  test("a put that fails after writing leaves no temp copy of the value", () => {
    run("secrets.sh", ["init", "bayon"], { env: env() });
    // chown fails after the value is already in the temp file: the EXIT trap removes it.
    const r = run("secrets.sh", ["put", "bayon", "api", "FRM_API_TOKEN"], {
      env: { ...env(), BAYON_CHOWN: "false" },
      input: SENTINEL,
    });
    expect(r.status).not.toBe(0);
    expect(readdirSync(secrets("bayon", "api"))).toEqual([]);
    // …and in a pipeline's subshell too, where traps are not inherited (gen).
    const g = run("secrets.sh", ["gen", "bayon", "FRM_API_TOKEN", "api"], {
      env: { ...env(), BAYON_CHOWN: "false" },
    });
    expect(g.status).not.toBe(0);
    expect(readdirSync(secrets("bayon", "api"))).toEqual([]);
  });

  test("gen writes the same 64-hex value to each service and prints none of it", () => {
    run("secrets.sh", ["init", "bayon"], { env: env() });
    const r = run(
      "secrets.sh",
      ["gen", "bayon", "FRM_API_TOKEN", "api", "web"],
      { env: env() },
    );
    expect(r.status).toBe(0);
    const api = readFileSync(
      join(secrets("bayon", "api"), "FRM_API_TOKEN"),
      "utf8",
    );
    const web = readFileSync(
      join(secrets("bayon", "web"), "FRM_API_TOKEN"),
      "utf8",
    );
    expect(api).toMatch(/^[0-9a-f]{64}$/);
    expect(web).toBe(api);
    expect(r.out).not.toContain(api);
  });

  test("list names files, modes and sizes, never a value", () => {
    run("secrets.sh", ["init", "bayon"], { env: env() });
    run("secrets.sh", ["put", "bayon", "migrate", "FRM_BACKUP_KEY"], {
      env: env(),
      input: SENTINEL,
    });
    const r = run("secrets.sh", ["list", "bayon"], { env: env() });
    // macOS's ls adds "@" after the mode when a file has extended attributes.
    expect(r.out).toMatch(/^-r--r-----@? \S+ \d+ migrate\/FRM_BACKUP_KEY$/m);
    expect(r.out).not.toContain(SENTINEL);
  });

  test.skipIf(spawnSync("ssh-keygen", ["-?"]).error !== undefined)(
    "ssh-key stores a 0400 key and one restricted authorized_keys line per project",
    () => {
      mkdirSync(join(dir, "home", ".ssh"), { recursive: true });
      writeFileSync(
        join(dir, "home", ".ssh", "authorized_keys"),
        "ssh-ed25519 AAAA owner@mac\n",
      );
      run("secrets.sh", ["init", "bayon-stg"], { env: env() });
      for (let i = 0; i < 2; i += 1) {
        const r = run(
          "secrets.sh",
          ["ssh-key", "bayon-stg", "10.123.2.128/26"],
          { env: env() },
        );
        expect(r.status).toBe(0);
      }
      const key = join(secrets("bayon-stg", "supervisor"), "FRM_SSH_KEY");
      expect(modeOf(key)).toBe("0400");
      expect(readFileSync(key, "utf8")).toContain("OPENSSH PRIVATE KEY");
      const lines = readFileSync(
        join(dir, "home", ".ssh", "authorized_keys"),
        "utf8",
      )
        .trim()
        .split("\n");
      expect(lines[0]).toBe("ssh-ed25519 AAAA owner@mac");
      const ours = lines.filter((l) => l.endsWith(" bayon-bayon-stg"));
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatch(
        /^from="10\.123\.2\.128\/26",restrict,port-forwarding ssh-ed25519 /,
      );
      expect(
        run("secrets.sh", ["ssh-key", "bayon-stg", "0.0.0.0"], { env: env() })
          .status,
      ).not.toBe(0);
    },
  );

  describe("password", () => {
    beforeEach(() => {
      mkdirSync(join(dir, "srv", "bayon"), { recursive: true });
      writeFileSync(
        join(dir, "srv", "bayon", "release.env"),
        "BAYON_TAG=0123456789ab\n",
      );
      // The stand-in for `docker run … hash-password.js`: reads the password, prints a fake hash.
      writeFileSync(
        join(dir, "docker"),
        `#!/bin/sh\nread -r pw\necho "\${#pw}" > "${join(dir, "docker-saw")}"\necho 'scrypt$15$8$1$c2FsdA==$aGFzaA=='\n`,
      );
      chmodSync(join(dir, "docker"), 0o755);
      run("secrets.sh", ["init", "bayon"], { env: env() });
    });

    test("a generated 24-character password goes to the TTY only; the hash is stored", () => {
      const r = run("secrets.sh", ["password", "bayon"], { env: env() });
      expect(r.status).toBe(0);
      const shown = /\n {4}([A-Za-z0-9]{24})\n/.exec(
        readFileSync(join(dir, "tty"), "utf8"),
      )?.[1];
      expect(shown).toBeDefined();
      expect(r.out).not.toContain(shown ?? "");
      expect(readFileSync(join(dir, "docker-saw"), "utf8").trim()).toBe("24");
      const stored = join(secrets("bayon", "web"), "FRM_WEB_PASSWORD_HASH");
      expect(readFileSync(stored, "utf8")).toBe(
        "scrypt$15$8$1$c2FsdA==$aGFzaA==\n",
      );
      expect(modeOf(stored)).toBe("0440");
    });

    test("--own refuses fewer than 20 characters and takes a long one", () => {
      writeFileSync(join(dir, "tty"), "too-short\n");
      expect(
        run("secrets.sh", ["password", "bayon", "--own"], { env: env() })
          .status,
      ).not.toBe(0);
      writeFileSync(join(dir, "tty"), `${SENTINEL}\n`);
      const r = run("secrets.sh", ["password", "bayon", "--own"], {
        env: env(),
      });
      expect(r.status).toBe(0);
      expect(r.out).not.toContain(SENTINEL);
    });

    test("--stdin takes the first line of stdin, CR stripped, writes nothing to the TTY, and refuses a short one", () => {
      const short = run("secrets.sh", ["password", "bayon", "--stdin"], {
        env: env(),
        input: "too-short\n",
      });
      expect(short.status).not.toBe(0);
      const r = run("secrets.sh", ["password", "bayon", "--stdin"], {
        env: env(),
        input: `${SENTINEL}\r\nsecond line\n`,
      });
      expect(r.status).toBe(0);
      expect(r.out).not.toContain(SENTINEL);
      expect(readFileSync(join(dir, "docker-saw"), "utf8").trim()).toBe(
        String(SENTINEL.length),
      );
      expect(existsSync(join(dir, "tty"))).toBe(false);
      expect(
        readFileSync(
          join(secrets("bayon", "web"), "FRM_WEB_PASSWORD_HASH"),
          "utf8",
        ),
      ).toBe("scrypt$15$8$1$c2FsdA==$aGFzaA==\n");
    });
  });
});

describe("bayon.sh", () => {
  const log = () => join(dir, "ssh.log");
  const commands = () => (existsSync(log()) ? readFileSync(log(), "utf8") : "");

  function stub(
    responses: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    // The ssh stand-in: logs the remote command, answers by pattern, swallows stdin when asked for.
    const script = [
      "#!/bin/sh",
      "for last; do :; done",
      `printf '%s\\n' "$last" >> "${log()}"`,
      'case "$last" in',
      '  *"df -B1"*) echo "${STUB_FREE:-100000000000}" ;;',
      '  *"/dev/stdin"*|*"docker build"*) cat >/dev/null ;;',
      '  *"sed -n \'s/^BAYON_TAG="*) echo "${STUB_CURRENT:-aaaaaaaaaaaa}" ;;',
      '  *"live-sessions.mjs"*) echo "${STUB_LIVE:-0}" ;;',
      '  *"ps --status running --services"*) printf "%s\\n" ${STUB_RUNNING:-} ;;',
      "  *\"ps --format\"*) printf 'api=healthy\\nweb=healthy\\nsupervisor=healthy\\n' ;;",
      '  *"id -u bayon"*) printf "${STUB_IDS:-1001\\n1001\\nbayon docker}\\n" ;;',
      '  *"secrets.sh list"*) printf "%b" "${STUB_LIST:-}" ;;',
      '  *"ssh_host_ed25519_key.pub"*) echo "${STUB_HOSTKEY:-}" ;;',
      '  *"/tmp/known_hosts"*) cat > "${STUB_CAPTURE:-/dev/null}" ;;',
      "esac",
      "exit 0",
    ].join("\n");
    writeFileSync(join(dir, "ssh"), script);
    chmodSync(join(dir, "ssh"), 0o755);
    return {
      BAYON_SSH: join(dir, "ssh"),
      // RFC 5737 examples: no real address is ever written in this repository.
      BAYON_HOST: "ops@192.0.2.10",
      BAYON_ADDR: "192.0.2.10",
      BAYON_DRAIN_WAIT: "0",
      BAYON_POLL: "0",
      BAYON_HEALTH_WAIT: "0",
      ...responses,
    };
  }

  test("an unknown project or command is refused before any ssh", () => {
    expect(
      run("bayon.sh", ["frm", "shiva", "pause"], { env: stub() }).status,
    ).toBe(1);
    expect(run("bayon.sh", ["nope"], { env: stub() }).status).toBe(2);
    expect(commands()).toBe("");
  });

  test("build refuses under the 35 G floor, and builds nothing", () => {
    const r = run("bayon.sh", ["build", "HEAD"], {
      env: stub({ STUB_FREE: String(20 * 2 ** 30) }),
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/under the 35 G floor/);
    expect(commands()).not.toContain("docker build");
  });

  test("build labels the image and tags it with the commit", () => {
    const sha = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim();
    const r = run("bayon.sh", ["build", "HEAD"], { env: stub() });
    expect(r.status).toBe(0);
    expect(commands()).toContain(
      `docker build -f deploy/Dockerfile --pull=false --build-arg REVISION=${sha} --label frm.managed=1 --label frm.deploy=bayon --label org.opencontainers.image.revision=${sha} -t bayon-app:${sha.slice(0, 12)} -`,
    );
  });

  test("known-hosts streams the host's own key line into the supervisor's /tmp/known_hosts", () => {
    const capture = join(dir, "known_hosts");
    const key = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${"x".repeat(43)}`;
    const r = run("bayon.sh", ["known-hosts", "bayon-stg"], {
      env: stub({ STUB_HOSTKEY: key, STUB_CAPTURE: capture }),
    });
    expect(r.status).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe(`192.0.2.10 ${key}\n`);
    expect(commands()).toContain(
      "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub",
    );
    expect(commands()).toContain(
      "exec -T supervisor sh -c 'cat > /tmp/known_hosts'",
    );
  });

  test("known-hosts refuses a line that is not a key, and writes nothing", () => {
    const r = run("bayon.sh", ["known-hosts", "bayon-stg"], {
      env: stub({ STUB_HOSTKEY: "not a key" }),
    });
    expect(r.status).toBe(1);
    expect(commands()).not.toContain("/tmp/known_hosts");
  });

  test("frm runs in the supervisor container, quoted", () => {
    const r = run(
      "bayon.sh",
      [
        "frm",
        "bayon-stg",
        "executor",
        "add",
        "stg-lab",
        "--host",
        "192.0.2.10",
      ],
      { env: stub() },
    );
    expect(r.status).toBe(0);
    expect(commands()).toContain(
      "docker compose -p bayon-stg --env-file /srv/bayon/bayon-stg/release.env -f /srv/bayon/bayon-stg/compose.yaml exec -T supervisor frm executor add stg-lab --host 192.0.2.10",
    );
  });

  test("frm config apply streams the local file to frm's stdin in the container", () => {
    const file = join(dir, "seed.json");
    writeFileSync(file, JSON.stringify({ repos: [] }));
    const r = run("bayon.sh", ["frm", "bayon-stg", "config", "apply", file], {
      env: stub(),
    });
    expect(r.status).toBe(0);
    expect(commands()).toContain(
      "exec -T supervisor frm config apply /dev/stdin",
    );
    expect(commands()).not.toContain(file);
  });

  test("frm config apply refuses a missing file, extra arguments, or a file naming ctr-lab", () => {
    const file = join(dir, "seed.json");
    const apply = (...args: string[]) =>
      run("bayon.sh", ["frm", "bayon", "config", "apply", ...args], {
        env: stub(),
      }).status;
    expect(apply(join(dir, "nope.json"))).toBe(1);
    writeFileSync(file, JSON.stringify({ repos: [] }));
    expect(apply(file, "extra")).toBe(1);
    writeFileSync(
      file,
      JSON.stringify({ agents: [{ id: "a", executor_id: "ctr-lab" }] }),
    );
    expect(apply(file)).toBe(1);
    expect(commands()).toBe("");
  });

  test("without BAYON_HOST or BAYON_ADDR, nothing reaches the host", () => {
    const env = { ...stub(), BAYON_HOST: "", BAYON_ADDR: "" };
    const frm = run("bayon.sh", ["frm", "bayon", "pause"], { env });
    expect(frm.status).toBe(1);
    expect(frm.out).toMatch(/set BAYON_HOST/);
    expect(
      run("bayon.sh", ["print-release", "bayon", "0123456789ab"], { env }).out,
    ).toMatch(/set BAYON_ADDR/);
    expect(commands()).toBe("");
  });

  test.each([
    [["frm", "bayon", "executor", "image", "ctr-lab"]],
    [["frm", "bayon", "runner", "conformance", "fixture"]],
    [
      [
        "frm",
        "bayon",
        "runner",
        "conformance",
        "fixture",
        "--executor",
        "local",
      ],
    ],
    [["frm", "bayon", "runner", "conformance", "fixture", "--executor=local"]],
    [["down", "bayon", "-v"]],
  ])("refuses %j without touching the host", (args) => {
    const r = run("bayon.sh", args, { env: stub() });
    expect(r.status).toBe(1);
    expect(commands()).toBe("");
  });

  test("down -v on staging removes only its own volume and stg-lab's objects, by label", () => {
    expect(
      run("bayon.sh", ["down", "bayon-stg", "-v"], { env: stub() }).status,
    ).toBe(0);
    const c = commands();
    expect(c).toContain(
      "--filter label=frm.managed=1 --filter label=frm.deploy=bayon-stg",
    );
    expect(c).toContain(
      "--filter label=frm.managed=1 --filter label=frm.executor=stg-lab",
    );
    expect(c).not.toMatch(/ctr-lab|srv-lab|prune/);
  });

  test("upgrade pauses, then refuses while a turn is in flight, stopping nothing", () => {
    const r = run("bayon.sh", ["upgrade", "bayon", "bbbbbbbbbbbb"], {
      env: stub({ STUB_LIVE: "2" }),
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/2 session\(s\) still have a turn in flight/);
    expect(commands()).toContain("exec -T supervisor frm pause");
    expect(commands()).not.toContain("stop web api supervisor");
  });

  test("upgrade refuses when a writer still runs after stop, before any migration", () => {
    const r = run("bayon.sh", ["upgrade", "bayon", "bbbbbbbbbbbb"], {
      env: stub({ STUB_RUNNING: "api" }),
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/still running after stop: api/);
    expect(commands()).not.toContain("run --rm migrate");
  });

  test("upgrade --force: pause, stop, lock check, backup + migrate, up, and it stays paused", () => {
    const r = run("bayon.sh", ["upgrade", "bayon", "bbbbbbbbbbbb", "--force"], {
      env: stub({ STUB_LIVE: "1" }),
    });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/The fleet is PAUSED/);
    const c = commands();
    const order = [
      "frm pause",
      "stop web api supervisor",
      "ps --status running --services",
      "supervisor.lock",
      "release.env.previous",
      "run --rm migrate",
      "up -d",
    ].map((step) => c.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("install refuses a bayon account that is uid 10001", () => {
    const r = run("bayon.sh", ["install", "bayon-stg", "bbbbbbbbbbbb"], {
      env: stub({ STUB_IDS: "10001\\n10001\\nbayon docker" }),
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/must not be uid or gid 10001/);
  });

  test("install stops for secrets still to provision; every object it makes is labelled", () => {
    const r = run("bayon.sh", ["install", "bayon-stg", "bbbbbbbbbbbb"], {
      env: stub(),
    });
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/secrets still to provision.*api\/FRM_API_TOKEN/);
    const c = commands();
    expect(c).toContain(
      "docker volume create --label frm.managed=1 --label frm.deploy=bayon-stg bayon-stg_home",
    );
    expect(c).toContain(
      "--label frm.managed=1 --label frm.deploy=bayon-stg -v bayon-stg_home:/v bayon-app:bbbbbbbbbbbb chown 10001:10001 /v",
    );
    expect(c).not.toContain("up -d");
  });

  test("install with every secret in place brings the project up", () => {
    const list = [
      "api/FRM_API_TOKEN",
      "web/FRM_API_TOKEN",
      "web/FRM_WEB_PASSWORD_HASH",
      "supervisor/FRM_BACKUP_KEY",
      "migrate/FRM_BACKUP_KEY",
      "supervisor/FRM_SSH_KEY",
    ]
      .map((n) => `-r--r----- 0:10001 64 ${n}\\n`)
      .join("");
    const r = run("bayon.sh", ["install", "bayon-stg", "bbbbbbbbbbbb"], {
      env: stub({ STUB_LIST: list }),
    });
    expect(r.status).toBe(0);
    expect(commands()).toContain("compose.yaml up -d");
  });
});

describe("git-credential-frm", () => {
  const helper = (action: string) =>
    spawnSync("sh", [join(HERE, "git-credential-frm"), action], {
      encoding: "utf8",
      input: "protocol=https\nhost=github.com\n\n",
      env: { PATH: process.env.PATH ?? "", FRM_SECRETS_DIR: dir },
    });

  test("get answers from the file store; store and erase do nothing", () => {
    writeFileSync(join(dir, "FRM_GIT_TOKEN"), `${SENTINEL}\n`);
    expect(helper("get").stdout).toBe(
      `username=x-access-token\npassword=${SENTINEL}\n`,
    );
    for (const action of ["store", "erase"]) {
      const r = helper(action);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(readFileSync(join(dir, "FRM_GIT_TOKEN"), "utf8")).toBe(
      `${SENTINEL}\n`,
    );
  });

  test("no token file: no answer", () => {
    expect(helper("get").stdout).toBe("");
  });
});

describe("migrate.sh", () => {
  test("refuses while a supervisor lock is present", () => {
    writeFileSync(join(dir, "supervisor.lock"), "{}");
    const r = spawnSync("sh", [join(HERE, "migrate.sh")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", FRM_HOME: dir },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/supervisor\.lock exists/);
  });
});
