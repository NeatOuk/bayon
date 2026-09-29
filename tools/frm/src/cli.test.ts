import { describe, expect, test } from "vitest";
import { COMMANDS, USAGE, cliErrorText, parseCli } from "./cli.js";
import { SMOKE_DEADLINE_MS } from "./smoke/budget.js";

const failure = (argv: string[]) => {
  const parsed = parseCli(argv);
  return parsed.ok ? null : parsed.error;
};

test("smoke defaults: M0's smoke, the fixture runner, the step-budget deadline, temp home removed", () => {
  expect(parseCli(["smoke"])).toEqual({
    ok: true,
    value: {
      command: "smoke",
      options: {
        mode: "normal",
        runner: "fixture",
        timeoutMs: SMOKE_DEADLINE_MS.normal,
        keep: false,
        certify: false,
      },
    },
  });
});

test("--hang shortens the deadline; --timeout and --keep are honoured", () => {
  const hang = parseCli(["smoke", "--hang"]);
  expect(hang.ok && hang.value).toMatchObject({
    options: { mode: "hang", timeoutMs: SMOKE_DEADLINE_MS.hang },
  });
  const custom = parseCli([
    "smoke",
    "--runner",
    "sdk",
    "--timeout",
    "30",
    "--keep",
  ]);
  expect(custom.ok && custom.value).toMatchObject({
    options: { mode: "normal", runner: "sdk", timeoutMs: 30_000, keep: true },
  });
});

test("--m1 runs the M1 acceptance test under its own step-budget deadline", () => {
  const m1 = parseCli(["smoke", "--m1"]);
  expect(m1.ok && m1.value).toMatchObject({
    options: { mode: "m1", runner: "fixture", timeoutMs: SMOKE_DEADLINE_MS.m1 },
  });
  const keep = parseCli(["smoke", "--m1", "--keep", "--timeout", "90"]);
  expect(keep.ok && keep.value).toMatchObject({
    options: { mode: "m1", keep: true, timeoutMs: 90_000 },
  });
});

test("--m2 runs the M2 acceptance test, on the fixture or a real runner (the real check)", () => {
  const m2 = parseCli(["smoke", "--m2"]);
  expect(m2.ok && m2.value).toMatchObject({
    options: { mode: "m2", runner: "fixture", timeoutMs: SMOKE_DEADLINE_MS.m2 },
  });
  const real = parseCli(["smoke", "--m2", "--runner", "sdk"]);
  expect(real.ok && real.value).toMatchObject({
    options: { mode: "m2", runner: "sdk", timeoutMs: SMOKE_DEADLINE_MS.m2 },
  });
  expect(USAGE).toContain("--m2");
});

test("--m3 runs the M3 acceptance test on the fixture builder; --executor passes through to it", () => {
  const m3 = parseCli(["smoke", "--m3"]);
  expect(m3).toEqual({
    ok: true,
    value: {
      command: "smoke",
      options: {
        mode: "m3",
        runner: "fixture",
        timeoutMs: SMOKE_DEADLINE_MS.m3,
        keep: false,
        certify: false,
      },
    },
  });
  const placed = parseCli(["smoke", "--m3", "--executor", "ctr-lab"]);
  expect(placed.ok && placed.value).toMatchObject({
    options: {
      mode: "m3",
      executor: "ctr-lab",
      timeoutMs: SMOKE_DEADLINE_MS.m3Container,
    },
  });
  // --executor local is the plain --m3, on its own deadline.
  const local = parseCli(["smoke", "--m3", "--executor", "local"]);
  expect(local.ok && local.value).toMatchObject({
    options: { mode: "m3", timeoutMs: SMOKE_DEADLINE_MS.m3 },
  });
  expect(USAGE).toContain("--m3");
  expect(USAGE).toContain("FRM_CONTAINER=1");
});

test("--certify certifies a real runner: only with --runner sdk, never a runner-conformance flag", () => {
  const real = parseCli(["smoke", "--m2", "--runner", "sdk", "--certify"]);
  expect(real.ok && real.value).toMatchObject({
    options: { mode: "m2", runner: "sdk", certify: true },
  });
  expect(failure(["smoke", "--certify"])?.message).toMatch(
    /--certify certifies a real runner/,
  );
  expect(
    failure(["runner", "conformance", "fixture", "--certify"])?.message,
  ).toMatch(/--certify belong to frm smoke/);
  expect(USAGE).toContain("--certify");
});

test("--m3's real checks wait for a credential; --executor needs --m3", () => {
  expect(failure(["smoke", "--m3", "--runner", "sdk"])?.message).toMatch(
    /--m3 .*wait for the owner's credential: drop --runner sdk/,
  );
  expect(failure(["smoke", "--m2", "--executor", "ctr-lab"])?.message).toMatch(
    /--executor to frm runner conformance and frm smoke --m3/,
  );
  expect(failure(["smoke", "--m3", "--out", "x"])?.message).toMatch(
    /--out, --model and --compression belong to frm runner conformance/,
  );
  expect(failure(["smoke", "--model", "m.cheap"])?.message).toMatch(
    /--model and --compression belong to frm runner conformance/,
  );
  expect(failure(["smoke", "--compression"])?.message).toMatch(
    /--compression belong to frm runner conformance/,
  );
});

test("the mode flags are separate smokes; --hang and --m1 need the fixture runner", () => {
  expect(failure(["smoke", "--m1", "--hang"])?.message).toMatch(
    /--hang and --m1 are separate smokes/,
  );
  expect(failure(["smoke", "--m2", "--m1"])?.message).toMatch(/--m1 and --m2/);
  expect(failure(["smoke", "--m1", "--runner", "sdk"])?.message).toMatch(
    /--m1/,
  );
  expect(failure(["smoke", "--hang", "--runner", "sdk"])?.message).toMatch(
    /--hang/,
  );
});

test("no command or --help asks for the usage", () => {
  expect(parseCli([])).toEqual({ ok: true, value: { command: "help" } });
  expect(parseCli(["--help"])).toEqual({
    ok: true,
    value: { command: "help" },
  });
  expect(parseCli(["smoke", "-h"])).toEqual({
    ok: true,
    value: { command: "help", topic: "smoke" },
  });
});

test("bad input is a validation error with the reason", () => {
  expect(failure(["deploy"])).toMatchObject({ class: "validation" });
  expect(failure(["deploy"])?.message).toMatch(
    /^frm: unknown command "deploy"/,
  );
  expect(failure(["smoke", "--runner", "gpt"])?.message).toMatch(/runner/);
  expect(failure(["smoke", "--timeout", "soon"])?.message).toMatch(/timeoutMs/);
  expect(failure(["smoke", "--nope"])?.message).toMatch(/--nope/);
});

test("runner conformance: the runner on local by default, --out made absolute, its own deadline", () => {
  expect(parseCli(["runner", "conformance", "fixture"])).toMatchObject({
    ok: true,
    value: {
      command: "runner-conformance",
      options: {
        runnerId: "fixture",
        executorId: "local",
        timeoutMs: 1_200_000,
      },
    },
  });
  // No --model: every model a role binding runs (resolved against the API when it runs).
  const bare = parseCli(["runner", "conformance", "fixture"]);
  expect(bare).toMatchObject({ ok: true });
  expect(JSON.stringify(bare)).not.toContain("modelId");
  const custom = parseCli([
    "runner",
    "conformance",
    "some-runner",
    "--model",
    "some-runner.complex",
    "--executor",
    "ctr-1",
    "--out",
    "docs/conformance",
    "--timeout",
    "60",
  ]);
  expect(custom).toMatchObject({
    ok: true,
    value: {
      options: {
        runnerId: "some-runner",
        executorId: "ctr-1",
        modelId: "some-runner.complex",
        compression: false,
        outDir: `${process.cwd()}/docs/conformance`,
        timeoutMs: 60_000,
      },
    },
  });
});

test("runner conformance --compression: a compression run, said in the usage", () => {
  expect(
    parseCli([
      "runner",
      "conformance",
      "some-runner",
      "--model",
      "some-runner.standard",
      "--compression",
    ]),
  ).toMatchObject({
    ok: true,
    value: {
      command: "runner-conformance",
      options: {
        runnerId: "some-runner",
        modelId: "some-runner.standard",
        executorId: "local",
        compression: true,
      },
    },
  });
  expect(USAGE).toContain("[--compression]");
  expect(USAGE).toMatch(/--compression {2}with context compression on/);
});

test("runner conformance refuses smoke flags and a missing runner; smoke refuses its flags", () => {
  expect(failure(["runner", "conformance"])?.message).toMatch(
    /frm runner conformance <runner>/,
  );
  expect(failure(["runner", "list"])?.class).toBe("validation");
  expect(
    failure(["runner", "conformance", "fixture", "--m1"])?.message,
  ).toMatch(/--m1 belong to frm smoke/);
  expect(
    failure(["runner", "conformance", "fixture", "--runner", "sdk"])?.message,
  ).toMatch(/--runner belong to frm smoke/);
  expect(failure(["smoke", "--executor", "local"])?.message).toMatch(
    /frm runner conformance/,
  );
});

describe("an unknown command or option names the closest one, never the whole manual", () => {
  test("an unknown command: the closest, the command list, and where the full usage is", () => {
    const message = failure(["setings", "set", "k", "v"])?.message ?? "";
    const lines = message.split("\n");
    expect(lines[0]).toBe(
      'frm: unknown command "setings". Did you mean "settings"?',
    );
    expect(message).toContain("  roots ");
    expect(message).toContain("  smoke ");
    expect(lines.at(-1)).toBe("frm --help for the full usage");
    // A command list, not the manual.
    expect(lines.length).toBeLessThan(25);
    expect(message).not.toContain("--m3");
  });

  test("an unknown command with nothing close says so without a guess", () => {
    const message = failure(["deploy"])?.message ?? "";
    expect(message.split("\n")[0]).toBe('frm: unknown command "deploy".');
  });

  test("frm help is the usage", () => {
    expect(parseCli(["help"])).toEqual({
      ok: true,
      value: { command: "help" },
    });
  });

  test("an unknown option on a known command: that command and its options only", () => {
    const message =
      failure(["settings", "set", "projects.local_roots", "/a", "--yez"])
        ?.message ?? "";
    expect(message.split("\n")).toEqual([
      'frm settings: unknown option "--yez". Did you mean "--yes"?',
      "frm settings options: --yes",
      `usage: ${COMMANDS.settings?.line ?? ""}`,
      "frm settings --help for more",
    ]);
  });

  test("an unknown option with a value (--opt=value) and on a command with no options", () => {
    expect(failure(["agent", "set", "b1", "--profil=p"])?.message).toMatch(
      /^frm agent: unknown option "--profil". Did you mean "--profile"\?/,
    );
    expect(failure(["pause", "--force"])?.message.split("\n")[1]).toBe(
      "frm pause takes no options",
    );
  });

  test("an option a command refuses by name keeps its own reason", () => {
    expect(
      failure(["agent", "set", "b1", "--mission-id", "m"])?.message,
    ).toMatch(/mission_id is set by the API/);
  });

  test("an option given to a command that does not take it is still refused by that command's own rule", () => {
    // --to belongs to frm restore: frm backup's own message says so.
    expect(failure(["backup", "--to", "/x"])?.message).toMatch(
      /--to and --replace belong to frm restore/,
    );
  });

  test("every option the table lists is one its command's parser knows", () => {
    for (const [word, command] of Object.entries(COMMANDS)) {
      for (const option of command.options) {
        const message = failure([word, `--${option}`])?.message ?? "";
        expect(message, `${word} --${option}`).not.toMatch(/unknown option/i);
      }
    }
  });

  test("a swapped pair is caught: --yse is --yes, rots is roots", () => {
    expect(failure(["settings", "set", "k", "v", "--yse"])?.message).toMatch(
      /^frm settings: unknown option "--yse". Did you mean "--yes"\?/,
    );
    expect(failure(["rots", "list"])?.message).toMatch(
      /^frm: unknown command "rots". Did you mean "roots"\?/,
    );
  });

  test("<command> --help is that command's usage", () => {
    expect(parseCli(["roots", "--help"])).toEqual({
      ok: true,
      value: { command: "help", topic: "roots" },
    });
    expect(parseCli(["settings", "set", "-h"])).toEqual({
      ok: true,
      value: { command: "help", topic: "settings" },
    });
  });

  test("the error text: a command's own message gets the frm prefix and one pointer", () => {
    expect(cliErrorText("usage: frm pause | frm resume (no arguments)")).toBe(
      "frm: usage: frm pause | frm resume (no arguments)\nfrm --help for the full usage",
    );
    const friendly = 'frm: unknown command "x".\nfrm --help for the full usage';
    expect(cliErrorText(friendly)).toBe(friendly);
  });

  test("the usage names the default home and frm roots", () => {
    expect(USAGE).toContain("~/.foreman");
    expect(USAGE).toContain("frm roots add <path>");
  });
});
