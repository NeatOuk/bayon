import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { tarball, type TarFile } from "./tar.js";

const dir = mkdtempSync(join(tmpdir(), "frm-tar-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FILES: TarFile[] = [
  { name: "Dockerfile", mode: 0o644, content: Buffer.from("FROM x\n") },
  { name: "gateway.sh", mode: 0o755, content: Buffer.alloc(1_000, 0x61) },
  { name: "empty", mode: 0o600, content: Buffer.alloc(0) },
];

test("the system tar extracts exactly the files, their bytes and their modes", () => {
  const tar = tarball(FILES);
  expect(tar.length % 512).toBe(0);
  writeFileSync(join(dir, "context.tar"), tar);
  expect(
    execFileSync("tar", ["-tf", "context.tar"], { cwd: dir, encoding: "utf8" })
      .trim()
      .split("\n"),
  ).toEqual(["Dockerfile", "gateway.sh", "empty"]);
  execFileSync("tar", ["-xf", "context.tar"], { cwd: dir });
  for (const file of FILES) {
    expect(readFileSync(join(dir, file.name))).toEqual(file.content);
    expect(statSync(join(dir, file.name)).mode & 0o777).toBe(file.mode);
  }
});

test("the same files always give the same bytes", () => {
  expect(tarball(FILES).equals(tarball(FILES))).toBe(true);
  expect(tarball(FILES).equals(tarball(FILES.slice(0, 2)))).toBe(false);
});

test("only plain top-level names", () => {
  for (const name of ["../x", "a/b", "", "a b", "x".repeat(101)]) {
    expect(() =>
      tarball([{ name, mode: 0o644, content: Buffer.alloc(1) }]),
    ).toThrow(/tar: refusing/);
  }
});
