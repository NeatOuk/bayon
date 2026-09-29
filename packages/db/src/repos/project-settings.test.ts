// One project's own settings against a real temp database: its
// staffing approval, its Jira source and its documentation source, each change written with one `project.set` audit row naming what
// changed, in one transaction; the same values again write nothing, a refusal writes nothing, and
// the other projects are never touched.
import {
  DEFAULT_JIRA_PUSH,
  FakeClock,
  NO_DELIVERY_CONFIG,
  NO_DOCS_SOURCE,
  NO_QA_CONFIG,
  NO_STEP_TIERS,
} from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setProjectSettings } from "./project-settings.js";
import { listProjects } from "./project-reads.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function fresh() {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        { id: "P-A", name: "P-A", kind: "single" },
        { id: "P-B", name: "P-B", kind: "single" },
      ],
    }),
  );
  return { db: t.db, clock };
}

const setProjectStaffApproval = (
  db: TempDb["db"],
  id: string,
  on: boolean,
  actor: string,
) => setProjectSettings(db, id, { staff_approval: on }, actor);

const approvalOf = async (db: TempDb["db"]) =>
  Object.fromEntries(
    unwrap(await listProjects(db)).map((p) => [
      p.workspace.id,
      p.workspace.staff_approval,
    ]),
  );

test("on, on again, off: each change one project.set row with its value; the same value writes nothing", async () => {
  const { db, clock } = await fresh();
  expect(await approvalOf(db)).toEqual({ "P-A": 0, "P-B": 0 });

  await clock.advance(5_000);
  expect(
    unwrap(await setProjectStaffApproval(db, "P-A", true, "operator")),
  ).toEqual({
    project: "P-A",
    staff_approval: true,
    jira: null,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: true,
  });
  expect(await approvalOf(db)).toEqual({ "P-A": 1, "P-B": 0 });

  expect(
    unwrap(await setProjectStaffApproval(db, "P-A", true, "operator")),
  ).toEqual({
    project: "P-A",
    staff_approval: true,
    jira: null,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: false,
  });
  expect(
    unwrap(await setProjectStaffApproval(db, "P-B", false, "operator")),
  ).toEqual({
    project: "P-B",
    staff_approval: false,
    jira: null,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: false,
  });

  await clock.advance(1_000);
  expect(
    unwrap(await setProjectStaffApproval(db, "P-A", false, "operator")),
  ).toEqual({
    project: "P-A",
    staff_approval: false,
    jira: null,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: true,
  });
  expect(await approvalOf(db)).toEqual({ "P-A": 0, "P-B": 0 });

  expect(
    unwrap(await listAudit(db)).map((a) => [
      a.ts,
      a.actor,
      a.action,
      a.target_kind,
      a.target_id,
      a.payload_json,
    ]),
  ).toEqual([
    [
      T0 + 5_000,
      "operator",
      "project.set",
      "project",
      "P-A",
      JSON.stringify({ staff_approval: true }),
    ],
    [
      T0 + 6_000,
      "operator",
      "project.set",
      "project",
      "P-A",
      JSON.stringify({ staff_approval: false }),
    ],
  ]);
});

test("an unknown project is not_found and an empty actor is refused; neither writes anything", async () => {
  const { db } = await fresh();
  expect(
    await setProjectStaffApproval(db, "P-X", true, "operator"),
  ).toMatchObject({
    ok: false,
    error: { class: "not_found", message: "project P-X does not exist" },
  });
  expect(await setProjectStaffApproval(db, "P-A", true, " ")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  expect(unwrap(await listAudit(db))).toEqual([]);
  expect(await approvalOf(db)).toEqual({ "P-A": 0, "P-B": 0 });
});

const SOURCE = {
  url: "https://acme.atlassian.net",
  email: "op@acme.test",
  jql: "project = ACME",
};

test("the Jira source: set, again, changed, off; one project.set row each, naming only the source", async () => {
  const { db, clock } = await fresh();
  await clock.advance(1_000);
  expect(
    unwrap(await setProjectSettings(db, "P-A", { jira: SOURCE }, "operator")),
  ).toEqual({
    project: "P-A",
    staff_approval: false,
    jira: SOURCE,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: true,
  });
  expect(
    unwrap(
      await setProjectSettings(db, "P-A", { jira: { ...SOURCE } }, "operator"),
    ).changed,
  ).toBe(false);
  const moved = { ...SOURCE, jql: "project = ACME AND type = Bug" };
  expect(
    unwrap(await setProjectSettings(db, "P-A", { jira: moved }, "operator")),
  ).toMatchObject({ jira: moved, changed: true });
  expect(
    unwrap(await setProjectSettings(db, "P-A", { jira: null }, "operator")),
  ).toMatchObject({ jira: null, changed: true });
  expect(
    unwrap(await setProjectSettings(db, "P-B", { jira: null }, "operator"))
      .changed,
  ).toBe(false);

  const listed = unwrap(await listProjects(db)).map((p) => [
    p.workspace.id,
    p.workspace.jira_url,
    p.workspace.jira_email,
    p.workspace.jira_jql,
  ]);
  expect(listed).toEqual([
    ["P-A", null, null, null],
    ["P-B", null, null, null],
  ]);
  expect(
    unwrap(await listAudit(db)).map((a) => JSON.parse(a.payload_json ?? "")),
  ).toEqual([{ jira: SOURCE }, { jira: moved }, { jira: null }]);
});

test("both settings in one call: one row naming both; an absent field is kept", async () => {
  const { db } = await fresh();
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P-A",
        { staff_approval: true, jira: SOURCE },
        "operator",
      ),
    ),
  ).toEqual({
    project: "P-A",
    staff_approval: true,
    jira: SOURCE,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: true,
  });
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P-A",
        { staff_approval: false },
        "operator",
      ),
    ),
  ).toEqual({
    project: "P-A",
    staff_approval: false,
    jira: SOURCE,
    qa: NO_QA_CONFIG,
    docs: NO_DOCS_SOURCE,
    delivery: NO_DELIVERY_CONFIG,
    jira_push: DEFAULT_JIRA_PUSH,
    step_tiers: NO_STEP_TIERS,
    context_compression: false,
    push_targets: [],
    qaTicket: null,
    changed: true,
  });
  expect(
    unwrap(await listAudit(db)).map((a) => JSON.parse(a.payload_json ?? "")),
  ).toEqual([
    { staff_approval: true, jira: SOURCE },
    { staff_approval: false },
  ]);
});

// The documentation source: its own four columns, its own line in the audit payload,
// and the one rule that is not a plain write — "same as Jira".

const DOCS = {
  kind: "confluence" as const,
  url: "https://acme.atlassian.net",
  email: "op@acme.test",
  spaces: ["ONE", "TWO"],
};

const docsColumnsOf = async (db: TempDb["db"], id: string) =>
  unwrap(await listProjects(db))
    .filter((p) => p.workspace.id === id)
    .map((p) => [
      p.workspace.docs_kind,
      p.workspace.docs_url,
      p.workspace.docs_email,
      p.workspace.docs_spaces_json,
    ])[0];

test("the documentation source: set, again, changed, off; one project.set row each, naming only it", async () => {
  const { db } = await fresh();
  expect(
    unwrap(await setProjectSettings(db, "P-A", { docs: DOCS }, "operator")),
  ).toMatchObject({ docs: DOCS, changed: true });
  expect(await docsColumnsOf(db, "P-A")).toEqual([
    "confluence",
    DOCS.url,
    DOCS.email,
    '["ONE","TWO"]',
  ]);

  // The same values again write nothing, the space list included.
  expect(
    unwrap(await setProjectSettings(db, "P-A", { docs: DOCS }, "operator"))
      .changed,
  ).toBe(false);

  const fewer = { ...DOCS, spaces: ["ONE"] };
  expect(
    unwrap(await setProjectSettings(db, "P-A", { docs: fewer }, "operator")),
  ).toMatchObject({ docs: fewer, changed: true });

  // Off clears the site and the account: nothing is left behind to read.
  expect(
    unwrap(
      await setProjectSettings(db, "P-A", { docs: NO_DOCS_SOURCE }, "operator"),
    ),
  ).toMatchObject({ docs: NO_DOCS_SOURCE, changed: true });
  expect(await docsColumnsOf(db, "P-A")).toEqual(["none", null, null, "[]"]);
  // The other project is never touched.
  expect(await docsColumnsOf(db, "P-B")).toEqual(["none", null, null, null]);

  expect(
    unwrap(await listAudit(db)).map((a) => JSON.parse(a.payload_json ?? "")),
  ).toEqual([
    { docs: DOCS },
    { docs: fewer },
    { docs: { kind: "none", url: null, email: null, spaces: [] } },
  ]);
});

test("same as Jira: a source with no site or account takes the project's, including one set in the same call", async () => {
  const { db } = await fresh();
  const bare = {
    kind: "confluence" as const,
    url: null,
    email: null,
    spaces: [],
  };

  // With no Jira source there is nothing to take: refused, and nothing is written.
  expect(
    await setProjectSettings(db, "P-A", { docs: bare }, "operator"),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(await docsColumnsOf(db, "P-A")).toEqual(["none", null, null, null]);
  expect(unwrap(await listAudit(db))).toEqual([]);

  // Both in one call: the docs source follows the Jira source this call leaves.
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P-A",
        { jira: SOURCE, docs: bare },
        "operator",
      ),
    ),
  ).toMatchObject({
    jira: SOURCE,
    docs: {
      kind: "confluence",
      url: SOURCE.url,
      email: SOURCE.email,
      spaces: [],
    },
  });
  // What is stored is the resolved site and account, not a blank to resolve again later.
  expect(await docsColumnsOf(db, "P-A")).toEqual([
    "confluence",
    SOURCE.url,
    SOURCE.email,
    "[]",
  ]);

  // One PATCH that turns the mirror off and asks for "same as Jira" is refused: the docs source
  // follows the Jira source this call LEAVES, and that call leaves none.
  expect(
    await setProjectSettings(db, "P-A", { jira: null, docs: bare }, "operator"),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  // Nothing of either was written: the mirror is still there and the docs are unchanged.
  expect(await docsColumnsOf(db, "P-A")).toEqual([
    "confluence",
    SOURCE.url,
    SOURCE.email,
    "[]",
  ]);
  expect(
    unwrap(await listProjects(db)).find((p) => p.workspace.id === "P-A")
      ?.workspace.jira_url,
  ).toBe(SOURCE.url);

  // A source of its own overrides it; turning the mirror off afterwards leaves the docs alone.
  const own = {
    kind: "confluence" as const,
    url: "https://other.atlassian.net",
    email: "docs@acme.test",
    spaces: [],
  };
  expect(
    unwrap(await setProjectSettings(db, "P-A", { docs: own }, "operator")),
  ).toMatchObject({ docs: own });
  expect(
    unwrap(await setProjectSettings(db, "P-A", { jira: null }, "operator")),
  ).toMatchObject({ jira: null, docs: own });
});

test("Jira push settings: set, the same map in another order, cleared; one project.set row per change", async () => {
  const { db } = await fresh();
  const push = {
    status_map: { done: "Done", started: "In Progress" },
    comment_prs: false,
  };
  expect(
    unwrap(
      await setProjectSettings(db, "P-A", { jira_push: push }, "operator"),
    ),
  ).toMatchObject({ jira_push: push, changed: true });
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P-A",
        {
          jira_push: {
            status_map: { started: "In Progress", done: "Done" },
            comment_prs: false,
          },
        },
        "operator",
      ),
    ).changed,
  ).toBe(false);
  const stored = async () =>
    unwrap(await listProjects(db)).map((p) => [
      p.workspace.id,
      p.workspace.jira_status_map_json,
      p.workspace.jira_comment_prs,
    ]);
  expect(await stored()).toEqual([
    ["P-A", '{"started":"In Progress","done":"Done"}', 0],
    ["P-B", null, 1],
  ]);
  expect(
    unwrap(
      await setProjectSettings(
        db,
        "P-A",
        { jira_push: DEFAULT_JIRA_PUSH },
        "operator",
      ),
    ),
  ).toMatchObject({ jira_push: DEFAULT_JIRA_PUSH, changed: true });
  expect(await stored()).toEqual([
    ["P-A", null, 1],
    ["P-B", null, 1],
  ]);
  expect(
    unwrap(await listAudit(db)).map((a) => JSON.parse(a.payload_json ?? "")),
  ).toEqual([
    {
      jira_push: {
        status_map: { started: "In Progress", done: "Done" },
        comment_prs: false,
      },
    },
    { jira_push: { status_map: {}, comment_prs: true } },
  ]);
});

test("context compression (049): off by default; on, on again, off; one project.set row per change, naming only it", async () => {
  const { db, clock } = await fresh();
  const compressionOf = async () =>
    Object.fromEntries(
      unwrap(await listProjects(db)).map((p) => [
        p.workspace.id,
        p.workspace.context_compression,
      ]),
    );
  expect(await compressionOf()).toEqual({ "P-A": 0, "P-B": 0 });

  await clock.advance(1_000);
  const on = unwrap(
    await setProjectSettings(db, "P-A", { context_compression: true }, "op"),
  );
  expect(on).toMatchObject({ context_compression: true, changed: true });
  const again = unwrap(
    await setProjectSettings(db, "P-A", { context_compression: true }, "op"),
  );
  expect(again).toMatchObject({ context_compression: true, changed: false });
  // An unrelated patch keeps it.
  unwrap(await setProjectSettings(db, "P-A", { staff_approval: true }, "op"));
  expect(await compressionOf()).toEqual({ "P-A": 1, "P-B": 0 });

  await clock.advance(1_000);
  const off = unwrap(
    await setProjectSettings(db, "P-A", { context_compression: false }, "op"),
  );
  expect(off).toMatchObject({ context_compression: false, changed: true });
  expect(await compressionOf()).toEqual({ "P-A": 0, "P-B": 0 });

  expect(
    unwrap(await listAudit(db)).map((a) => [a.ts, a.action, a.payload_json]),
  ).toEqual([
    [T0 + 1_000, "project.set", JSON.stringify({ context_compression: true })],
    [T0 + 1_000, "project.set", JSON.stringify({ staff_approval: true })],
    [T0 + 2_000, "project.set", JSON.stringify({ context_compression: false })],
  ]);
});
