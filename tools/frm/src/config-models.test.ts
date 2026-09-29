// `frm config apply`'s models and `frm models list`: each row judged by its runner's
// own adapter, written as the operator's in the file's one transaction and audited; settings
// changes need --yes; a second apply of the same file writes nothing. The runner with rules of its
// own is found through the registry, never by name (Invariant 1).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, canonicalJson } from "@bayon/core";
import { getModel, listAuditPage, listModels } from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { registrations } from "@bayon/runners";
import { runnersWithModelRules } from "@bayon/runners/models";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runConfigCommand } from "./config-apply.js";

const dir = mkdtempSync(join(tmpdir(), "frm-models-"));
let t: TempDb;

/** The runner whose adapter has model rules of its own, and its shipped rows. */
const [RULED = ""] = runnersWithModelRules();
const ruled = registrations().find((r) => r.runner.id === RULED);
if (ruled === undefined) throw new Error("no runner with model rules");
/** Its first shipped model string: `provider/model` for a provider it serves. */
const SHIPPED = ruled.models[0]?.model ?? "";
const PROVIDER = SHIPPED.slice(0, SHIPPED.indexOf("/"));
const URL = "http://10.0.0.7:11434/v1";

beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(t.db, 1));
  // The ruled runner's rows as a booted supervisor registers them.
  unwrap(
    await seedRows(t.db, {
      runners: [
        {
          id: RULED,
          kind: ruled.runner.kind,
          adapter: ruled.runner.adapter,
          caps_json: canonicalJson(ruled.runner.caps),
          defaults_json: JSON.stringify(ruled.runner.defaults),
        },
      ],
      models: ruled.models.map((m) => ({
        id: m.id,
        runner_id: RULED,
        tier: m.tier,
        model: m.model,
        price_in_per_mtok: 0,
        price_out_per_mtok: 0,
        active: 1,
      })),
    }),
  );
});
afterAll(() => {
  t.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function apply(
  name: string,
  body: unknown,
  yes = false,
  env: Readonly<Record<string, string>> = {},
) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(body));
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runConfigCommand(
    { action: "apply", file, yes },
    {
      env: { FRM_HOME: dir, FRM_DB: t.path, ...env },
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
    },
  );
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

async function list(runner?: string) {
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runConfigCommand(
    { action: "models", ...(runner === undefined ? {} : { runner }) },
    {
      env: { FRM_HOME: dir, FRM_DB: t.path },
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
    },
  );
  return { code, out, err: errs.join("\n") };
}

const audits = async () =>
  unwrap(await listAuditPage(t.db, { limit: 100, action: "model.*" }))
    .rows.map((a) => ({ action: a.action, target_id: a.target_id }))
    .toReversed();

const local = (o: Record<string, unknown> = {}) => ({
  id: `${RULED}.local`,
  runner_id: RULED,
  tier: "standard",
  model: `${PROVIDER}/own-model:30b`,
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  context_tokens: 32_768,
  ...o,
});

test("a model the adapter refuses writes nothing, and says why", async () => {
  const bad = await apply("bad", {
    models: [local({ model: "no-provider-here" })],
    run_classes: [],
  });
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("provider/model");
  const unknownRunner = await apply("unknown", {
    models: [local({ runner_id: "nope" })],
  });
  expect(unknownRunner.err).toContain(
    "runner nope is not registered: boot the supervisor",
  );
  const twice = await apply("twice", { models: [local(), local()] });
  expect(twice.err).toContain("listed twice");
  const shape = await apply("shape", {
    models: [local({ price_out_per_mtok: -1 })],
  });
  expect(shape.code).toBe(2);
  expect((await getModel(t.db, `${RULED}.local`)).ok).toBe(false);
});

test("a new model is written as the operator's, takes its tier, is audited; the same file again writes nothing", async () => {
  const first = await apply("add", { models: [local()] });
  expect(first.err).not.toContain("nothing written");
  expect(first.code).toBe(0);
  expect(first.out).toContain("1 models");
  expect(unwrap(await getModel(t.db, `${RULED}.local`))).toMatchObject({
    source: "operator",
    active: 1,
    tier: "standard",
    // A cache price left out is the input price.
    price_cache_read_per_mtok: 0,
    settings_json: "{}",
  });
  const standard = ruled.models.find((m) => m.tier === "standard");
  expect(unwrap(await getModel(t.db, standard?.id ?? ""))).toMatchObject({
    active: 0,
    source: "adapter",
  });
  expect(await audits()).toEqual([
    { action: "model.put", target_id: `${RULED}.local` },
  ]);

  expect((await apply("add-again", { models: [local()] })).code).toBe(0);
  expect(await audits()).toHaveLength(1);
});

test("a second active operator model in a tier is refused, naming the rule", async () => {
  const r = await apply("clash", {
    models: [local({ id: `${RULED}.other`, model: `${PROVIDER}/x:1b` })],
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain("already runs operator model");
  expect((await getModel(t.db, `${RULED}.other`)).ok).toBe(false);
});

test("a settings change is shown and needs --yes; a bad URL is refused either way", async () => {
  const withUrl = { models: [local({ settings: { provider_url: URL } })] };
  const refused = await apply("url", withUrl);
  expect(refused.code).toBe(2);
  expect(refused.out).toBe(
    `model ${RULED}.local: settings {} -> {"provider_url":"${URL}"}: this opens port 11434 to any host from inside the ${RULED} sandbox (Seatbelt can't restrict by host), and lapses the model's certificate`,
  );
  expect(refused.err).toContain("repeat the command with --yes");
  expect(unwrap(await getModel(t.db, `${RULED}.local`)).settings_json).toBe(
    "{}",
  );

  const bad = await apply(
    "bad-url",
    { models: [local({ settings: { provider_url: "http://u:p@10.0.0.7/" } })] },
    true,
  );
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("credentials");

  expect((await apply("url-yes", withUrl, true)).code).toBe(0);
  expect(unwrap(await getModel(t.db, `${RULED}.local`)).settings_json).toBe(
    `{"provider_url":"${URL}"}`,
  );
  // Unchanged settings need no --yes.
  expect(
    (
      await apply("price", {
        models: [
          local({ settings: { provider_url: URL }, price_in_per_mtok: 0.1 }),
        ],
      })
    ).code,
  ).toBe(0);
});

test("a provider URL on the port this install's API listens on is refused, --yes or not", async () => {
  const onApi = await apply(
    "api-port",
    {
      models: [
        local({ settings: { provider_url: "http://10.0.0.7:4000/v1" } }),
      ],
    },
    true,
    { FRM_API_PORT: "4000" },
  );
  expect(onApi.code).toBe(2);
  expect(onApi.err).toContain("uses port 4000");
  const metadata = await apply(
    "metadata",
    {
      models: [
        local({ settings: { provider_url: "http://169.254.169.254/" } }),
      ],
    },
    true,
  );
  expect(metadata.err).toContain("link-local");
});

test("a model string is fixed once stored", async () => {
  const renamed = await apply("rename", {
    models: [
      local({
        model: `${PROVIDER}/renamed:1b`,
        settings: { provider_url: URL },
      }),
    ],
  });
  expect(renamed.code).toBe(1);
  expect(renamed.err).toContain("fixed once stored");
});

test("models list shows every non-retired model, or one runner's, with its source and settings", async () => {
  const all = await list();
  expect(all.code).toBe(0);
  const own = all.out.find((l) => l.startsWith(`${RULED}.local `));
  expect(own).toContain("active");
  expect(own).toContain("operator");
  expect(own).toContain(`settings {"provider_url":"${URL}"}`);
  const mine = await list(RULED);
  expect(mine.out).toHaveLength(ruled.models.length + 1);
  expect(mine.out.every((l) => l.split("  ")[1] === RULED)).toBe(true);
  const none = await list("nope");
  expect(none.code).toBe(1);
  expect(none.err).toContain("no models of runner nope");
  expect(unwrap(await listModels(t.db)).length).toBeGreaterThan(0);
});
