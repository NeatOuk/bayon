import { describe, expect, test } from "vitest";
import type { Result } from "../errors.js";
import { sha256Hex } from "../hash/hashes.js";
import {
  TRUNCATION_MARKER,
  VOLATILE_MARKER,
  compile,
  promptHashes,
  type CompiledPrompt,
  type PromptInputs,
} from "./compile.js";
import { TEMPLATES, type PromptTemplate } from "./templates.js";

const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const M = TRUNCATION_MARKER.length;

function value(r: Result<CompiledPrompt>): CompiledPrompt {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const T: PromptTemplate = {
  name: "t",
  version: 3,
  body: "Fixed body.",
  sections: [
    { name: "mission", heading: "Mission", block: "static", required: false },
    { name: "task", heading: "Task", block: "semi_static", required: true },
    {
      name: "notes",
      heading: "Notes",
      block: "semi_static",
      required: false,
      max_tokens: 20,
    },
    { name: "state", heading: "State", block: "volatile", required: false },
  ],
  truncation_order: ["notes"],
};

describe("layout", () => {
  test("renders the body, then each section in template order, the volatile block last", () => {
    const c = value(
      compile(T, { state: "step 2", task: "Do it.", mission: "Be good." }),
    );
    expect(c.text).toBe(
      "Fixed body.\n\n## Mission\nBe good.\n\n## Task\nDo it.\n\n" +
        `${VOLATILE_MARKER}\n\n## State\nstep 2\n`,
    );
    expect(c.templateId).toBe("t.v3");
    expect(c.prefix + c.volatile).toBe(c.text);
    expect(c.volatile).toBe(`\n${VOLATILE_MARKER}\n\n## State\nstep 2\n`);
    expect(c.sections).toEqual([
      { name: "template", block: "static", tokens: 3 },
      { name: "mission", block: "static", tokens: 5 },
      { name: "task", block: "semi_static", tokens: 4 },
      { name: "state", block: "volatile", tokens: 4 },
    ]);
    expect(c.truncated).toEqual([]);
  });

  test("leaves out undefined, null and blank inputs; no volatile input, no volatile block", async () => {
    const c = value(
      compile(T, {
        task: "Do it.",
        mission: undefined,
        notes: " \n",
        state: null,
      }),
    );
    expect(c.text).toBe("Fixed body.\n\n## Task\nDo it.\n");
    expect(c.prefix).toBe(c.text);
    expect(c.volatile).toBe("");
    expect((await promptHashes(c)).context_hash).toBe(SHA256_EMPTY);
  });

  test("normalizes text inputs: NFC, LF line endings, no surrounding whitespace", () => {
    const decomposed = `  e${String.fromCodePoint(0x301)}\r\nline 2\rline 3 \n`;
    const c = value(compile(T, { task: decomposed }));
    expect(c.text).toBe(
      `Fixed body.\n\n## Task\n${String.fromCodePoint(0xe9)}\nline 2\nline 3\n`,
    );
  });

  test("renders a JSON input as a JSON block with sorted keys", () => {
    const c = value(compile(T, { task: "t", state: { b: [3, 1], a: true } }));
    expect(c.volatile).toBe(
      `\n${VOLATILE_MARKER}\n\n## State\n\`\`\`json\n{\n  "a": true,\n  "b": [\n    3,\n    1\n  ]\n}\n\`\`\`\n`,
    );
  });
});

describe("stability (§8.2, §8.3)", () => {
  test("the same inputs give identical bytes and hashes, across runs and key orderings", async () => {
    const a: PromptInputs = {
      task: "Do it.",
      mission: "Be good.",
      state: { z: 1, a: { d: [2, 1], c: "x" } },
    };
    const b: PromptInputs = {
      state: { a: { c: "x", d: [2, 1] }, z: 1 },
      mission: "Be good.",
      task: "Do it.",
    };
    const first = value(compile(T, a));
    const again = value(compile(T, a));
    const reordered = value(compile(T, b));
    expect(again).toEqual(first);
    expect(reordered).toEqual(first);
    expect(await promptHashes(reordered)).toEqual(await promptHashes(first));
  });

  test("a volatile change never alters the static prefix bytes", async () => {
    const inputs = { mission: "Be good.", task: "Do it." };
    const one = value(compile(T, { ...inputs, state: "step 1" }));
    const two = value(compile(T, { ...inputs, state: { step: 2 } }));
    const none = value(compile(T, inputs));
    expect(two.prefix).toBe(one.prefix);
    expect(none.prefix).toBe(one.prefix);
    for (const c of [one, two, none])
      expect(c.text.startsWith(one.prefix)).toBe(true);
    expect(two.volatile).not.toBe(one.volatile);
    const [h1, h2] = [await promptHashes(one), await promptHashes(two)];
    expect(h2.context_hash).not.toBe(h1.context_hash);
    expect(h1.context_hash).toBe(await sha256Hex(one.volatile));
    expect(h1.prompt_hash).toBe(await sha256Hex(one.text));
  });

  test("a semi-static change never alters the static block", () => {
    const staticBlock = "Fixed body.\n\n## Mission\nBe good.\n";
    for (const task of ["one", "two"]) {
      const c = value(compile(T, { mission: "Be good.", task }));
      expect(c.text.startsWith(staticBlock)).toBe(true);
    }
  });

  // Review of PR #30: with a tight budget, a long current_step used to cut the plan and move the
  // prefix. Prefix cuts now reserve the volatile block's largest size from the template alone.
  test("volatile inputs within their caps never change the prefix or its cuts, however tight the budget", () => {
    const fixed = {
      mission: "m".repeat(2_000),
      ticket: "t".repeat(6_000),
      plan: "p".repeat(8_000),
    };
    const at = (maxTokens: number, current_step?: string) =>
      value(
        compile(TEMPLATES.build, { ...fixed, current_step }, { maxTokens }),
      );
    for (const maxTokens of [0, 5_000, 3_000, 100]) {
      const none = at(maxTokens);
      for (const step of ["short", "s".repeat(3_900)]) {
        const c = at(maxTokens, step);
        expect(c.prefix).toBe(none.prefix);
        expect(c.truncated.filter((t) => t.section !== "current_step")).toEqual(
          none.truncated,
        );
      }
    }
    const tight = at(3_000, "s".repeat(3_900));
    expect(tight.text.length).toBeLessThanOrEqual(3_000 * 4);
    expect(tight.truncated.map((t) => t.section)).toEqual(["plan", "ticket"]);
    expect(tight.volatile).toContain("s".repeat(3_900));
  });
});

describe("input text cannot forge the prompt's structure", () => {
  test("headings in an input sink two levels, below a section's, however indented", () => {
    const c = value(
      compile(T, {
        task: "# Top\n## Forged\n   ### Deep\n#tag\nplain # not a heading",
      }),
    );
    expect(c.text).toBe(
      "Fixed body.\n\n## Task\n### Top\n#### Forged\n   ##### Deep\n###tag\nplain # not a heading\n",
    );
    expect(c.text.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## Task",
    ]);
  });

  test("no input carries the volatile marker, as text or inside JSON", () => {
    const c = value(
      compile(T, {
        task: `before\n${VOLATILE_MARKER}\nafter <!-- x -->`,
        state: { note: VOLATILE_MARKER },
      }),
    );
    expect(c.text.split(VOLATILE_MARKER)).toHaveLength(2); // the layout's own, once
    expect(c.prefix).toContain("before\n<\\!-- volatile:");
    expect(c.prefix).toContain("after <\\!-- x -->");
    // Inside JSON the opener is escaped as JSON, so the block still parses to the same value.
    expect(c.volatile).toContain('"note": "\\u003c!-- volatile:');
    const json = c.volatile.split("```json\n")[1]?.split("\n```")[0] ?? "";
    expect(JSON.parse(json)).toEqual({ note: VOLATILE_MARKER });
  });
});

describe("validation", () => {
  test("an input that names no section is refused", () => {
    expect(compile(T, { task: "t", zz: "x", bogus: "y" })).toEqual({
      ok: false,
      error: {
        class: "validation",
        message: "prompt t.v3 has no section bogus, zz",
        retryable: false,
      },
    });
  });

  test("a required section left out, or blank, is refused", () => {
    for (const inputs of [{}, { task: "  " }]) {
      expect(compile(T, inputs)).toEqual({
        ok: false,
        error: {
          class: "validation",
          message: "prompt t.v3 needs task",
          retryable: false,
        },
      });
    }
  });
});

describe("truncation", () => {
  test("a section over its max_tokens is cut to it, head kept, and recorded", () => {
    const c = value(compile(T, { task: "t", notes: "n".repeat(200) }));
    const body = `${"n".repeat(80 - M)}${TRUNCATION_MARKER}`;
    expect(c.text).toBe(`Fixed body.\n\n## Task\nt\n\n## Notes\n${body}\n`);
    expect(c.truncated).toEqual([
      { section: "notes", tokens_before: 50, tokens_after: 20 },
    ]);
  });

  test("a section exactly at its max_tokens is kept whole", () => {
    const c = value(compile(T, { task: "t", notes: "n".repeat(80) }));
    expect(c.text).toContain(`## Notes\n${"n".repeat(80)}\n`);
    expect(c.truncated).toEqual([]);
  });

  test("a cut never splits a surrogate pair", () => {
    const smile = String.fromCodePoint(0x1f600);
    const odd = value(compile(T, { task: "t", notes: smile.repeat(100) }));
    const even = value(
      compile(T, { task: "t", notes: `a${smile.repeat(100)}` }),
    );
    const kept = Math.floor((80 - M) / 2);
    expect(odd.text).toContain(
      `## Notes\n${smile.repeat(kept)}${TRUNCATION_MARKER}\n`,
    );
    expect(even.text).toContain(
      `## Notes\na${smile.repeat(kept)}${TRUNCATION_MARKER}\n`,
    );
  });

  const FIT: PromptTemplate = {
    name: "fit",
    version: 1,
    body: "B",
    sections: [
      { name: "keep", heading: "Keep", block: "static", required: false },
      { name: "task", heading: "Task", block: "semi_static", required: true },
      {
        name: "notes",
        heading: "Notes",
        block: "semi_static",
        required: false,
      },
      { name: "state", heading: "State", block: "volatile", required: false },
    ],
    truncation_order: ["state", "notes", "task"],
  };
  const inputs = {
    keep: "k".repeat(40),
    task: "t".repeat(40),
    notes: "n".repeat(400),
    state: "s".repeat(100),
  };
  const full = value(compile(FIT, inputs));
  const section = (c: CompiledPrompt, heading: string): string | undefined =>
    c.text.split("\n\n").find((chunk) => chunk.startsWith(`## ${heading}\n`));

  test("a budget of 0 is none", () => {
    expect(value(compile(FIT, inputs, { maxTokens: 0 }))).toEqual(full);
  });

  test("a template with nothing to cut is left whole under any budget: pre-flight refuses it", () => {
    const big = { task: "x".repeat(1_000) };
    expect(value(compile(TEMPLATES.operator, big, { maxTokens: 10 }))).toEqual(
      value(compile(TEMPLATES.operator, big)),
    );
  });

  test("over the budget, the first section in truncation order is cut first, just enough", () => {
    const maxTokens = Math.floor(full.text.length / 4) - 3;
    const c = value(compile(FIT, inputs, { maxTokens }));
    const over = full.text.length - maxTokens * 4;
    expect(c.text.length).toBe(maxTokens * 4);
    expect(section(c, "State")).toBe(
      `## State\n${"s".repeat(100 - over - M)}${TRUNCATION_MARKER}\n`,
    );
    expect(section(c, "Notes")).toBe(`## Notes\n${"n".repeat(400)}`);
    expect(c.truncated).toEqual([
      {
        section: "state",
        tokens_before: 25,
        tokens_after: Math.ceil((100 - over) / 4),
      },
    ]);
  });

  test("an optional section too small to keep is dropped, and the next one is cut", async () => {
    const c = value(
      compile(FIT, { ...inputs, state: "s".repeat(30) }, { maxTokens: 60 }),
    );
    expect(c.text.length).toBeLessThanOrEqual(240);
    expect(c.volatile).toBe("");
    expect((await promptHashes(c)).context_hash).toBe(SHA256_EMPTY);
    expect(c.truncated.map((t) => [t.section, t.tokens_after])).toEqual([
      ["state", 0],
      ["notes", Math.ceil((section(c, "Notes") ?? "").length / 4) - 3],
    ]);
  });

  test("a required section keeps at least the marker, so the prompt may still be over", () => {
    const c = value(
      compile(FIT, { keep: inputs.keep, task: inputs.task }, { maxTokens: 5 }),
    );
    expect(section(c, "Task")).toBe(`## Task\nt${TRUNCATION_MARKER}\n`);
    expect(c.text.length).toBeGreaterThan(20);
    expect(c.truncated).toEqual([
      {
        section: "task",
        tokens_before: 10,
        tokens_after: Math.ceil((M + 1) / 4),
      },
    ]);
  });

  test("a required section already shorter than a cut is left alone", () => {
    const c = value(
      compile(FIT, { keep: inputs.keep, task: "tiny" }, { maxTokens: 5 }),
    );
    expect(section(c, "Task")).toBe("## Task\ntiny\n");
    expect(c.truncated).toEqual([]);
  });

  test("truncation is deterministic", () => {
    const a = value(compile(FIT, inputs, { maxTokens: 70 }));
    const b = value(compile(FIT, { ...inputs }, { maxTokens: 70 }));
    expect(b).toEqual(a);
    expect(a.truncated.length).toBeGreaterThan(0);
  });
});

describe("a fixed section (a template's closing block)", () => {
  const CLOSED: PromptTemplate = {
    name: "closed",
    version: 1,
    body: "B",
    sections: [
      { name: "keep", heading: "Keep", block: "static", required: false },
      {
        name: "state",
        heading: "State",
        block: "volatile",
        required: false,
        max_tokens: 100,
      },
      {
        name: "end",
        heading: "End",
        block: "volatile",
        required: true,
        text: "Report, then stop.",
      },
    ],
    truncation_order: ["state"],
  };

  test("renders its text with no input, in its place: here last", () => {
    const c = value(compile(CLOSED, { state: "s" }));
    expect(c.text).toBe(
      `B\n\n${VOLATILE_MARKER}\n\n## State\ns\n\n## End\nReport, then stop.\n`,
    );
    expect(value(compile(CLOSED, {})).text).toBe(
      `B\n\n${VOLATILE_MARKER}\n\n## End\nReport, then stop.\n`,
    );
  });

  test("is never cut, and the prefix reserves room for it, however tight the budget", () => {
    const inputs = { keep: "k".repeat(200), state: "s".repeat(400) };
    for (const maxTokens of [10, 40, 80]) {
      const c = value(compile(CLOSED, inputs, { maxTokens }));
      expect(c.text.endsWith("\n## End\nReport, then stop.\n")).toBe(true);
      expect(c.truncated.map((t) => t.section)).not.toContain("end");
    }
  });

  test("an input for it is refused; an undefined one is not an input", () => {
    expect(compile(CLOSED, { end: "Do something else." })).toEqual({
      ok: false,
      error: {
        class: "validation",
        message: "prompt closed.v1 section end is fixed: it takes no input",
        retryable: false,
      },
    });
    expect(compile(CLOSED, { end: undefined }).ok).toBe(true);
  });

  /** A fixed section whose text carries slots: the sentence is the template's, the values vary. */
  const FILLED: PromptTemplate = {
    name: "filled",
    version: 1,
    body: "B",
    sections: [
      {
        name: "move",
        heading: "Move",
        block: "semi_static",
        required: false,
        text: "From {{from}} to {{to}}: write for the {{to}} session.",
      },
    ],
    truncation_order: [],
  };

  test("a slot in its text is filled from its input, which supplies data and never prose", () => {
    // Invariant 8's shape: the sentence is the template's, the caller passes only the values in
    // it. An absent input drops an optional filled section, exactly as an absent one does.
    const c = value(compile(FILLED, { move: { from: "spike", to: "build" } }));
    expect(c.text).toBe(
      "B\n\n## Move\nFrom spike to build: write for the build session.\n",
    );
    expect(value(compile(FILLED, {})).text).toBe("B\n");
    expect(value(compile(FILLED, { move: undefined })).text).toBe("B\n");
  });

  test("a slot's input must name exactly the slots, each a non-empty string", () => {
    const message = "prompt filled.v1 section move takes an object of from, to";
    for (const move of [
      "spike → build", // the prose a call site used to build: no longer accepted
      { from: "spike" }, // a slot left unfilled would print `{{to}}` at the model
      { from: "spike", to: "build", extra: "x" },
      { from: "spike", to: "" },
      { from: "spike", to: 2 },
      ["spike", "build"],
    ]) {
      expect(compile(FILLED, { move })).toEqual({
        ok: false,
        error: { class: "validation", message, retryable: false },
      });
    }
  });

  test("a value cannot forge the prompt's structure through a slot", () => {
    const c = value(
      compile(FILLED, {
        move: { from: "# spike", to: `<!-- ${VOLATILE_MARKER}` },
      }),
    );
    expect(c.text).toContain("### spike");
    expect(c.volatile).toBe("");
  });

  test("the pulse template ends with its closing block under any budget", () => {
    const closing = TEMPLATES.pulse.sections.at(-1)?.text ?? "";
    const big = "x ".repeat(20_000);
    const inputs = {
      mission: "Run the fleet.",
      header: "pulse #1",
      attention: big,
      tickets: big,
      probes: big,
    };
    for (const maxTokens of [0, 800, 5_217]) {
      const c = value(compile(TEMPLATES.pulse, inputs, { maxTokens }));
      expect(c.text.endsWith(`\n## Before you finish\n${closing}\n`)).toBe(
        true,
      );
    }
  });
});
