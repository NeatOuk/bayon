import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { compressToolResult } from "./compress.js";
import {
  determinismSamples,
  realisticJson,
  realisticTestLog,
} from "./fixtures.js";

// The same block must compress to the same bytes on every call, in every process and locale: a
// re-sent history is only byte-stable (and the prompt-cache prefix only holds) if it does.
const opts = { originalPath: "/w/.foreman/ctx/dd.txt" };

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

test(
  "1000 runs of the same block give the same output",
  { timeout: 60_000 },
  () => {
    const log = realisticTestLog().split("\n").slice(0, 600).join("\n");
    const issues = JSON.parse(realisticJson()) as unknown[];
    const json = JSON.stringify(issues.slice(0, 80), null, 2);
    const blocks = [log, json];
    const first = blocks.map((b) => compressToolResult(b, opts));
    expect(first.map((c) => c.kind === "compressed" && c.rule)).toEqual([
      "dedupe+head-tail",
      "json-array",
    ]);
    const differing = blocks.map((b, k) => {
      let n = 0;
      for (let run = 0; run < 1_000; run += 1) {
        if (
          JSON.stringify(compressToolResult(b, opts)) !==
          JSON.stringify(first[k])
        )
          n += 1;
      }
      return n;
    });
    expect(differing).toEqual([0, 0]);
  },
);

test("a Turkish locale gives the same bytes", () => {
  const here = determinismSamples().map((s) =>
    digest(compressToolResult(s, opts)),
  );
  // A child node in tr_TR: .ts sources directly (type stripping), `.js` specifiers mapped to them.
  const hook = `export async function resolve(s, c, next) {
    try { return await next(s, c); } catch (e) {
      if (s.startsWith(".") && s.endsWith(".js")) return next(s.slice(0, -3) + ".ts", c);
      throw e;
    }
  }`;
  const dir = new URL("./", import.meta.url).href;
  const script = `
    import { register } from "node:module";
    import { createHash } from "node:crypto";
    register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hook)}));
    const { compressToolResult } = await import(${JSON.stringify(`${dir}compress.ts`)});
    const f = await import(${JSON.stringify(`${dir}fixtures.ts`)});
    const samples = f.determinismSamples();
    const digest = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    console.log(JSON.stringify({
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      number: (1234.5).toLocaleString(),
      digests: samples.map((s) => digest(compressToolResult(s, ${JSON.stringify(opts)}))),
    }));
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      env: { ...process.env, LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(child.stderr).toBe("");
  const there = JSON.parse(child.stdout) as {
    locale: string;
    number: string;
    digests: string[];
  };
  // The child really ran in Turkish, so the comparison cannot pass vacuously.
  expect(there.locale).toBe("tr-TR");
  expect(there.number).toBe("1.234,5");
  expect(there.digests).toEqual(here);
});

test("the rules call no clock, randomness, locale or environment", () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir).filter(
    (name) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      name !== "fixtures.ts",
  );
  expect(sources).toContain("compress.ts");
  const banned =
    /localeCompare|toLocale|\bIntl\b|\bDate\b|Math\.random|performance|process\.|require\(|node:/;
  for (const name of sources) {
    expect(readFileSync(new URL(name, dir), "utf8"), name).not.toMatch(banned);
  }
});
