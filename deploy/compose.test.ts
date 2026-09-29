import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

// Static guards on the deployment: compose.yaml is rendered for
// both projects the way compose interpolates it, parsed with zod, and held to the shared-host rules.
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TEXT = readFileSync(`${HERE}compose.yaml`, "utf8");

/** The docker host's LAN address, as the operator's environment gives it: an RFC 5737 example here. */
const ADDR = "192.0.2.10";

/** What bayon.sh print-release writes: settings only, never a secret. */
function releaseEnv(project: string): Record<string, string> {
  const run = spawnSync(
    "bash",
    [`${HERE}bayon.sh`, "print-release", project, "0123456789ab"],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", BAYON_ADDR: ADDR },
    },
  );
  expect(run.status).toBe(0);
  return Object.fromEntries(
    run.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const eq = line.indexOf("=");
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
}

/** compose's `${NAME}` and `${NAME:?}`: a missing value is an error, as in compose. */
function interpolate(
  text: string,
  vars: Readonly<Record<string, string>>,
): string {
  return text.replace(/\$\{([A-Z_]+)(:\?[^}]*)?\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`compose.yaml needs ${name}`);
    return value;
  });
}

const Labels = z.record(z.string(), z.string());
const Service = z.looseObject({
  image: z.string().optional(),
  user: z.string(),
  read_only: z.literal(true),
  cap_drop: z.array(z.string()),
  security_opt: z.array(z.string()),
  labels: Labels,
  environment: z.record(z.string(), z.string()).default({}),
  volumes: z.array(z.string()).default([]),
  networks: z.array(z.string()).optional(),
  network_mode: z.string().optional(),
  ports: z.array(z.string()).optional(),
  logging: z.object({
    driver: z.literal("json-file"),
    options: z.object({ "max-size": z.string(), "max-file": z.string() }),
  }),
  cpus: z.number().positive(),
  mem_limit: z.string(),
  memswap_limit: z.string(),
  pids_limit: z.number().int().positive(),
  // Every item a string, as compose itself requires: an unquoted `a ? b : c` in a node -e one-liner
  // is a YAML mapping, and compose refuses the file (the first staging install).
  healthcheck: z.looseObject({ test: z.array(z.string()).min(4) }).optional(),
});
const Compose = z.object({
  name: z.string(),
  services: z.record(z.string(), Service),
  networks: z.record(
    z.string(),
    z.looseObject({
      internal: z.boolean().optional(),
      labels: Labels,
      ipam: z.object({ config: z.array(z.object({ subnet: z.string() })) }),
    }),
  ),
  volumes: z.record(
    z.string(),
    z.object({ external: z.literal(true), name: z.string() }),
  ),
});
type Compose = z.infer<typeof Compose>;

/** compose.yaml (or `text`) as compose would read it for `project`, not yet checked. */
function load(project: string, text: string = TEXT): unknown {
  return parse(interpolate(text, releaseEnv(project)), { merge: true });
}

function render(project: string): Compose {
  return Compose.parse(load(project));
}

const PROJECTS = ["bayon", "bayon-stg"] as const;
const SETTINGS = new Set(["FRM_SECRET_STORE", "FRM_SECRETS_DIR"]);
const SECRET_LIKE = /TOKEN|KEY|PASSWORD|SECRET|HASH/;

/** a.b.c.d/n as a 32-bit range. */
function range(cidr: string): readonly [number, number] {
  const [ip = "", bits = "32"] = cidr.split("/");
  const n = ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
  const size = 2 ** (32 - Number(bits));
  return [n, n + size - 1];
}
const overlaps = (a: string, b: string): boolean => {
  const [a0, a1] = range(a);
  const [b0, b1] = range(b);
  return a0 <= b1 && b0 <= a1;
};

describe.each(PROJECTS)("compose.yaml rendered for %s", (project) => {
  const c = render(project);
  const services = Object.entries(c.services);

  test("the project and the four services", () => {
    expect(c.name).toBe(project);
    expect(Object.keys(c.services).sort()).toEqual([
      "api",
      "migrate",
      "supervisor",
      "web",
    ]);
  });

  test("every service, network and volume is ours by label, and never an executor's", () => {
    const labelled = [
      ...services.map(([, s]) => s.labels),
      ...Object.values(c.networks).map((n) => n.labels),
    ];
    for (const labels of labelled) {
      expect(labels).toMatchObject({
        "frm.managed": "1",
        "frm.deploy": project,
      });
      expect(labels).not.toHaveProperty("frm.executor");
    }
  });

  test("FRM_HOME is /var/lib/frm/<project>, and the home volume is mounted exactly there (H2)", () => {
    for (const name of ["api", "supervisor", "migrate"]) {
      const s = c.services[name];
      expect(s?.environment.FRM_HOME).toBe(`/var/lib/frm/${project}`);
      expect(s?.volumes).toContain(`home:/var/lib/frm/${project}`);
    }
  });

  test("the home volume is external and named per project (M5)", () => {
    expect(c.volumes).toEqual({
      home: { external: true, name: `${project}_home` },
    });
  });

  test("only web publishes a port, bound to the host's LAN address", () => {
    for (const [name, s] of services) {
      if (name === "web")
        expect(s.ports).toEqual([
          `${ADDR}:${releaseEnv(project).BAYON_PORT}:5173`,
        ]);
      else expect(s.ports).toBeUndefined();
    }
  });

  test("hardened: user 10001, read-only root, no capabilities, no new privileges, capped logs and limits", () => {
    for (const [, s] of services) {
      expect(s.user).toBe("10001:10001");
      expect(s.cap_drop).toEqual(["ALL"]);
      expect(s.security_opt).toContain("no-new-privileges:true");
      expect(s.logging.options).toEqual({ "max-size": "10m", "max-file": "3" });
      expect(s.memswap_limit).toBe(s.mem_limit);
      expect(s).not.toHaveProperty("privileged");
      expect(s).not.toHaveProperty("pid");
    }
  });

  test("no Docker socket, and each service mounts only its own secrets, read-only", () => {
    for (const [name, s] of services) {
      expect(s.volumes.join(" ")).not.toMatch(/docker\.sock/);
      const secrets = s.volumes.filter((v) => v.includes("/secrets"));
      expect(secrets).toEqual([
        `/srv/bayon/${project}/secrets/${name}:/run/secrets:ro`,
      ]);
    }
  });

  test("no secret in any environment: only the store's two settings match", () => {
    for (const [, s] of services) {
      for (const key of Object.keys(s.environment)) {
        if (SECRET_LIKE.test(key)) expect(SETTINGS.has(key)).toBe(true);
      }
      expect(s.environment.FRM_SECRET_STORE ?? "file").toBe("file");
    }
  });

  test("networks: the API only on the internal core; web on edge and core; the supervisor also on egress", () => {
    expect(c.networks.core?.internal).toBe(true);
    expect(c.services.api?.networks).toEqual(["core"]);
    expect(c.services.web?.networks).toEqual(["edge", "core"]);
    expect(c.services.supervisor?.networks).toEqual(["core", "egress"]);
    expect(c.services.migrate?.network_mode).toBe("none");
  });

  test("the subnets avoid Docker's default pools, the LAN and the Mac's network", () => {
    for (const n of Object.values(c.networks)) {
      for (const { subnet } of n.ipam.config) {
        for (const forbidden of ["172.16.0.0/12", "192.168.0.0/16"])
          expect(overlaps(subnet, forbidden)).toBe(false);
      }
    }
  });

  test("the origin the web server allows is the published address", () => {
    const env = releaseEnv(project);
    expect(c.services.web?.environment.FRM_WEB_ORIGINS).toBe(
      `http://${env.BAYON_ADDR}:${env.BAYON_PORT}`,
    );
  });
});

describe("healthchecks (the first staging install)", () => {
  test.each(PROJECTS)(
    "api, supervisor and web each have one, every item a string, for %s",
    (project) => {
      const c = render(project);
      for (const name of ["api", "supervisor", "web"]) {
        const items = c.services[name]?.healthcheck?.test;
        expect(items?.slice(0, 3)).toEqual(["CMD", "node", "-e"]);
      }
    },
  );

  test("the check fails on the file as merged, with the scalars unquoted", () => {
    const unquoted = TEXT.replace(
      /^(\s+- )"((?:fetch|require)\(.*\))"$/gm,
      "$1$2",
    );
    expect(unquoted).not.toBe(TEXT);
    const checked = Compose.safeParse(load("bayon", unquoted));
    expect(checked.success).toBe(false);
    const paths = (checked.error?.issues ?? []).map((i) => i.path.join("."));
    expect(paths).toContain("services.api.healthcheck.test.3");
    expect(paths).toContain("services.web.healthcheck.test.3");
  });
});

describe("across projects", () => {
  test("FRM_HOME, subnets, ports and volumes all differ between bayon and bayon-stg (H2)", () => {
    const [prod, stg] = PROJECTS.map(render) as [Compose, Compose];
    expect(prod.services.supervisor?.environment.FRM_HOME).not.toBe(
      stg.services.supervisor?.environment.FRM_HOME,
    );
    expect(prod.volumes.home?.name).not.toBe(stg.volumes.home?.name);
    expect(prod.services.web?.ports).not.toEqual(stg.services.web?.ports);
    for (const a of Object.values(prod.networks))
      for (const b of Object.values(stg.networks))
        expect(
          overlaps(
            a.ipam.config[0]?.subnet ?? "",
            b.ipam.config[0]?.subnet ?? "",
          ),
        ).toBe(false);
  });

  test("release.env holds exactly its six settings and nothing secret-like", () => {
    const env = releaseEnv("bayon");
    expect(Object.keys(env).sort()).toEqual([
      "BAYON_ADDR",
      "BAYON_DIR",
      "BAYON_NET",
      "BAYON_PORT",
      "BAYON_PROJECT",
      "BAYON_TAG",
    ]);
    for (const key of Object.keys(env)) expect(key).not.toMatch(SECRET_LIKE);
  });

  test("the header warns that a new tag goes through bayon.sh upgrade", () => {
    expect(TEXT).toMatch(
      /Never `docker compose up -d` a new BAYON_TAG by hand/,
    );
  });
});
