// A project's push targets through `PATCH /projects/:id`'s writer (migration 039), against a real
// temp database: set, clear and unchanged; one `project.set` row naming only what changed; and every
// refusal — a foreign repo, a repo named twice, a bad or credentialled URL — writing nothing at all.
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  dumpAllRows,
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setProjectSettings } from "./project-settings.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const repo = (id: string, origin: string) => ({
  id,
  name: id,
  origin_url: origin,
  mirror_path: `/m/${id}.git`,
  doctrine_paths_json: "[]",
});

/** P-A: a folder project with one submodule. P-B: another project, whose repo P-A must not touch. */
async function fresh() {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      repos: [
        repo("a", "/src/a"),
        repo("a-web", "/src/a/web"),
        repo("b", "/src/b"),
      ],
      workspaces: [
        { id: "P-A", name: "P-A", kind: "submodule" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
      workspace_repos: [
        {
          workspace_id: "P-A",
          repo_id: "a-web",
          rel_path: "a/web",
          role: "dep",
          submodule_path: "web",
        },
        {
          workspace_id: "P-A",
          repo_id: "a",
          rel_path: "a",
          role: "primary",
          submodule_path: null,
        },
        { workspace_id: "P-B", repo_id: "b", rel_path: "b" },
      ],
    }),
  );
  return t.db;
}

const pushUrls = async (db: TempDb["db"]) =>
  Object.fromEntries(
    (
      (unwrap(await dumpAllRows(db)).repos ?? []) as Record<string, unknown>[]
    ).map((r) => [r.id, r.push_url]),
  );

const set = (
  db: TempDb["db"],
  entries: readonly { repo_id: string; push_url: string | null }[],
  project = "P-A",
) => setProjectSettings(db, project, { push_urls: entries }, "operator");

test("setting a target writes it, answers every repo's, and audits only the change", async () => {
  const db = await fresh();
  const out = unwrap(
    await set(db, [
      { repo_id: "a", push_url: "  git@forge.example:owner/a.git " },
      { repo_id: "a-web", push_url: null },
    ]),
  );
  expect(out.changed).toBe(true);
  // Primary first, then the submodules by path — trimmed as core's rule returns it.
  expect(out.push_targets).toEqual([
    {
      repo_id: "a",
      submodule_path: null,
      push_url: "git@forge.example:owner/a.git",
    },
    { repo_id: "a-web", submodule_path: "web", push_url: null },
  ]);
  expect(await pushUrls(db)).toEqual({
    a: "git@forge.example:owner/a.git",
    "a-web": null,
    b: null,
  });
  const audit = unwrap(await listAudit(db));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: "project.set", target_id: "P-A" });
  expect(JSON.parse(audit[0]?.payload_json ?? "null")).toEqual({
    push_urls: [{ repo_id: "a", push_url: "git@forge.example:owner/a.git" }],
  });
});

test("the same target again writes nothing; clearing it is a change", async () => {
  const db = await fresh();
  const url = "https://forge.example/owner/a.git";
  unwrap(await set(db, [{ repo_id: "a", push_url: url }]));
  const again = unwrap(await set(db, [{ repo_id: "a", push_url: url }]));
  expect(again.changed).toBe(false);
  expect(unwrap(await listAudit(db))).toHaveLength(1);

  const cleared = unwrap(await set(db, [{ repo_id: "a", push_url: "  " }]));
  expect(cleared.changed).toBe(true);
  expect((await pushUrls(db)).a).toBeNull();
  expect(
    JSON.parse(unwrap(await listAudit(db)).at(-1)?.payload_json ?? "null"),
  ).toEqual({ push_urls: [{ repo_id: "a", push_url: null }] });
});

test("a patch without push_urls still answers every repo's target", async () => {
  const db = await fresh();
  const out = unwrap(
    await setProjectSettings(db, "P-A", { staff_approval: true }, "operator"),
  );
  expect(out.push_targets.map((t) => t.repo_id)).toEqual(["a", "a-web"]);
});

test.each([
  [
    "another project's repo",
    [{ repo_id: "b", push_url: "git@forge.example:o/b.git" }],
    /repo b is not one of project P-A's repos\./,
  ],
  [
    "a repo named twice",
    [
      { repo_id: "a", push_url: "git@forge.example:o/a.git" },
      { repo_id: "a", push_url: null },
    ],
    /repo a is named twice\./,
  ],
  [
    "a local path",
    [{ repo_id: "a", push_url: "/src/elsewhere" }],
    /repo a: push target "\/src\/elsewhere" must be an https:\/\/, ssh:\/\/ or git@host:path URL\./,
  ],
  [
    "an http URL",
    [{ repo_id: "a", push_url: "http://forge.example/o/a.git" }],
    /must be an https:\/\/, ssh:\/\/ or git@host:path URL/,
  ],
  [
    "a credentialled URL",
    [{ repo_id: "a", push_url: "https://me:hunter2@forge.example/o/a.git" }],
    /must not carry credentials/,
  ],
])("%s is refused and nothing is written", async (_what, entries, message) => {
  const db = await fresh();
  const out = await setProjectSettings(
    db,
    "P-A",
    // A valid change beside it is not written either: the patch is one decision.
    { staff_approval: true, push_urls: entries },
    "operator",
  );
  expect(out).toMatchObject({ ok: false, error: { class: "validation" } });
  if (!out.ok) {
    expect(out.error.message).toMatch(message);
    expect(out.error.message).not.toContain("hunter2");
  }
  expect(await pushUrls(db)).toEqual({ a: null, "a-web": null, b: null });
  expect(unwrap(await listAudit(db))).toHaveLength(0);
});
