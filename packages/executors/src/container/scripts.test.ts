import { describe, expect, test } from "vitest";
import { GIT_ENV_FLOOR_SH, SAFE_GIT } from "../git.js";
import { ContainerExecutorConfig } from "./config.js";
import { CONTAINER_PATHS, layoutOf } from "./route.js";
import { RemoteScripts, type CtlOp, type RunSpec } from "./scripts.js";

/** `git` with SAFE_GIT, as a script line spells it. */
const SAFE_GIT_LINE = ["git", ...SAFE_GIT].join(" ");
/** …and its environment floor, as a script line spells the whole prefix. */
const GIT_LINE = `env ${GIT_ENV_FLOOR_SH} ${SAFE_GIT_LINE}`;

const SHA = "a".repeat(64);
const TOKEN = "0123456789abcdef";
const CTR = "0123456789ab";
const layout = layoutOf("/home/ops/frm");
const scripts = new RemoteScripts("ctr-lab", layout, CONTAINER_PATHS, SHA);
const { limits } = ContainerExecutorConfig.parse({
  ssh: { host: "h", user: "ops", identity_ref: "file:/k" },
  remote_root: "/home/ops/frm",
  image: "frm/x",
});
const spec: RunSpec = {
  sessionId: "ses-1",
  uid: 1000,
  gid: 1000,
  limits,
  image: `sha256:${SHA}`,
  network: "none",
};
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return "accepted";
};

describe("remote scripts", () => {
  test("the keepalive container: labels, caps, read-only but its root, and no env", () => {
    const run = scripts.runContainer(spec);
    for (const flag of [
      "--init",
      "--pull never",
      "--label frm.managed=1",
      "--label frm.executor=ctr-lab",
      "--label frm.session=ses-1",
      "--user 1000:1000",
      "--cpus 4",
      "--memory 3g --memory-swap 3g",
      "--pids-limit 512",
      "--ulimit core=0",
      `--ulimit fsize=${2 * 1024 ** 3}`,
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--read-only",
      "--network none",
      "--mount type=bind,src=/home/ops/frm/work/ses-1,dst=/frm/s/ses-1 ",
      "src=/home/ops/frm/bin/exec-shim-aaaaaaaaaaaa.mjs,dst=/opt/frm/exec-shim.mjs,readonly",
      // The mirror at its host path: a clone's alternates resolve on both sides.
      "src=/home/ops/frm/mirror,dst=/home/ops/frm/mirror,readonly",
      "sleep infinity",
    ]) {
      expect(run).toContain(flag);
    }
    expect(run).not.toMatch(/\s(?:-e|--env|--env-file)\s/);
  });

  test("every docker filter carries frm.managed=1 with the executor id", () => {
    for (const script of [
      scripts.guard(true),
      scripts.findContainer("ses-1"),
      scripts.runningContainer("ses-1"),
      scripts.listOwned(),
      scripts.release("ses-1", true),
    ]) {
      expect(script).toContain(
        "--filter label=frm.managed=1 --filter label=frm.executor=ctr-lab",
      );
    }
    expect(scripts.listOwned()).toContain("--filter label=frm.session ");
    expect(scripts.release("ses-1", false)).toContain(
      "--filter label=frm.session=ses-1",
    );
  });

  test("a mirror is named by a repo id and pushed into through one line that checks real paths", () => {
    expect(scripts.mirrorPath("repo_01")).toBe(
      "/home/ops/frm/mirror/repo_01.git",
    );
    const receive = scripts.receivePack("repo_01");
    expect(receive).not.toContain("\n");
    expect(receive).toContain("r=$(realpath /home/ops/frm)");
    expect(receive).toContain('d="$m/repo_01.git"');
    expect(receive).toContain('[ "$(realpath "$m")" = "$m" ]');
    expect(receive).toContain('[ "$(realpath "$d")" = "$d" ]');
    // SAFE_GIT on the far end too: no hook of the docker host's mirror ever runs.
    // An empty --template as well: the env floor shuts `init.templateDir` out of
    // system and global config, but $GIT_TEMPLATE_DIR in the ssh user's env would still plant a
    // hook set in every mirror this creates.
    expect(receive).toContain(
      `${GIT_LINE} init --quiet --bare --template= "$d"`,
    );
    expect(receive.endsWith(`exec ${GIT_LINE} receive-pack "$d"`)).toBe(true);
  });

  test("every git on the docker host carries SAFE_GIT, a read --no-optional-locks, and the env floor", () => {
    const listPins = scripts.listPins();
    const scripted = [
      scripts.receivePack("repo_01"),
      listPins,
      scripts.dropPins("repo_01", ["refs/frm/pin/S1"]),
      // Not the docker host's git but a session container's, whose HOME is the agent's: the
      // least-trusted git environment of the lot, so it takes the same floor.
      scripts.uploadPack(CTR, "ses-1", "/frm/s/ses-1/repo"),
    ].join("\n");
    expect(scripted.match(/\bgit /g)).toHaveLength(5);
    for (const at of scripted.split(/\bgit /).slice(1)) {
      expect(`git ${at}`.startsWith(`${SAFE_GIT_LINE} `)).toBe(true);
    }
    // Neither /etc/gitconfig nor that user's ~/.gitconfig is read by any of them.
    expect(
      scripted.match(new RegExp(`env ${GIT_ENV_FLOOR_SH} git `, "g")),
    ).toHaveLength(5);
    expect(listPins).toContain(
      `${GIT_LINE} --no-optional-locks --git-dir="$d" for-each-ref`,
    );
  });

  test("release removes only the session's labelled containers, and its root only on request, by real path", () => {
    const keep = scripts.release("ses-1", false);
    expect(keep).not.toContain("rm -rf");
    const remove = scripts.release("ses-1", true);
    expect(remove).toContain('w="$r/work/ses-1"');
    expect(remove).toContain('[ "$(realpath "$w")" = "$w" ] || {');
    expect(remove).toContain('rm -rf -- "$w"');
    for (const script of [keep, remove]) {
      expect(script).not.toMatch(/prune|docker rm -f \$\(docker ps -aq\)/);
    }
    for (const bad of [
      () => scripts.mirrorPath("../x"),
      () => scripts.mirrorPath("a b"),
      () => scripts.receivePack("x;reboot"),
      () => scripts.release("a'b", true),
    ]) {
      expect(refusal(bad)).toMatchObject({ class: "validation" });
    }
  });

  test("the layout is 0700, du is optional, and programs run under the shim", () => {
    expect(scripts.guard(false)).toContain('chmod 0700 "$r" "$r/bin"');
    expect(scripts.guard(false)).not.toContain("du -sxk");
    expect(scripts.guard(true)).toContain("du -sxk");
    // The docker host route is the shim's `host` mode: confined to remote_root by real path first.
    expect(scripts.run(null, TOKEN)).toBe(
      `exec node /home/ops/frm/bin/exec-shim-aaaaaaaaaaaa.mjs host ${TOKEN} /home/ops/frm`,
    );
    expect(scripts.run(CTR, TOKEN)).toBe(
      `exec docker exec -i ${CTR} node /opt/frm/exec-shim.mjs run ${TOKEN} /run/frm`,
    );
    expect(scripts.shimCheck()).toContain(`= ${SHA} ]`);
    expect(scripts.shimUpload()).toContain("exit 5");
  });

  test("ctl, sweep and rm only touch a running container labelled as ours", () => {
    const sweep = scripts.sweep(CTR, [TOKEN]);
    expect(sweep).toContain(
      `"true|1|ctr-lab") exec docker exec ${CTR} node /opt/frm/exec-shim.mjs sweep /run/frm ${TOKEN}`,
    );
    expect(sweep).toContain('*) echo "foreign container: $s"; exit 4');
    expect(scripts.ctl(CTR, TOKEN, "probe")).toContain(
      `ctl /run/frm ${TOKEN} probe`,
    );
    expect(scripts.ctl(null, TOKEN, "KILL")).toBe(
      `exec node /home/ops/frm/bin/exec-shim-aaaaaaaaaaaa.mjs ctl /home/ops/frm/run ${TOKEN} KILL`,
    );
    expect(scripts.removeContainer(CTR)).toContain(
      `if [ "$s" = "1|ctr-lab" ]; then docker rm -f ${CTR}`,
    );
  });

  test.each([
    [
      "an executor id with a space",
      () => new RemoteScripts("bad id", layout, CONTAINER_PATHS, SHA),
    ],
    [
      "a path with a space",
      () =>
        new RemoteScripts(
          "ctr-lab",
          layoutOf("/home/n frm"),
          CONTAINER_PATHS,
          SHA,
        ),
    ],
    [
      "a digest that is not hex",
      () => new RemoteScripts("ctr-lab", layout, CONTAINER_PATHS, "x"),
    ],
    ["a token with a command", () => scripts.run(null, "x; reboot")],
    ["a container name", () => scripts.run("frm-x", TOKEN)],
    ["an unknown op", () => scripts.ctl(null, TOKEN, "STOP" as CtlOp)],
    ["a session id with a quote", () => scripts.findContainer("a'b")],
    [
      "a memory with a command",
      () =>
        scripts.runContainer({
          ...spec,
          limits: { ...limits, memory: "3g;reboot" },
        }),
    ],
    [
      "negative pids",
      () => scripts.runContainer({ ...spec, limits: { ...limits, pids: -1 } }),
    ],
    [
      "zero cpus",
      () => scripts.runContainer({ ...spec, limits: { ...limits, cpus: 0 } }),
    ],
    [
      "a non-integer uid",
      () => scripts.runContainer({ ...spec, uid: Number.NaN }),
    ],
    [
      "an image with a command",
      () => scripts.runContainer({ ...spec, image: "x$(reboot)" }),
    ],
    [
      "a network with a space",
      () => scripts.runContainer({ ...spec, network: "a b" }),
    ],
  ])("refuses %s in a remote command", (_what, fn) => {
    expect(refusal(fn)).toMatchObject({ class: "validation" });
  });
});
