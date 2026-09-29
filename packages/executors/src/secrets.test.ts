import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { keychainSecrets, putKeychainSecret } from "./secrets.js";

// Spawns a stand-in `security` per case: more than the default 5 s on a loaded host.
vi.setConfig({ testTimeout: 30_000 });

// The Keychain writer and reader against a stand-in `security` that records its argv and stdin:
// the real Keychain is never touched. The value must reach stdin only, never argv.
const dir = mkdtempSync(join(tmpdir(), "bayon-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const VALUE = "0123456789abcdef".repeat(4);

function shim(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.argv"\n${body}\n`,
  );
  chmodSync(path, 0o700);
  return path;
}

test("putKeychainSecret passes the value on security -i's stdin, never in argv", async () => {
  const bin = shim("ok", `cat > "${dir}/ok.stdin"\nexit 0`);
  const put = await putKeychainSecret({
    bin,
    service: "foreman",
    account: "FRM_BACKUP_KEY",
    value: VALUE,
    replace: false,
  });
  expect(put).toEqual({ ok: true, value: undefined });
  const argv = readFileSync(join(dir, "ok.argv"), "utf8");
  expect(argv).toBe("-i\n");
  expect(argv).not.toContain(VALUE);
  expect(readFileSync(join(dir, "ok.stdin"), "utf8")).toBe(
    `add-generic-password -s foreman -a FRM_BACKUP_KEY -w ${VALUE}\n`,
  );
  await putKeychainSecret({
    bin,
    service: "foreman",
    account: "FRM_BACKUP_KEY",
    value: VALUE,
    replace: true,
  });
  expect(readFileSync(join(dir, "ok.stdin"), "utf8")).toContain(
    "add-generic-password -U -s foreman",
  );
});

test("a failed write reports the exit status with the value redacted from stderr", async () => {
  const bin = shim(
    "fail",
    `cat > /dev/null\necho "security: could not add ${VALUE}" >&2\nexit 45`,
  );
  const put = await putKeychainSecret({
    bin,
    service: "foreman",
    account: "FRM_BACKUP_KEY",
    value: VALUE,
    replace: false,
  });
  expect(put).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("exit 45") },
  });
  expect(JSON.stringify(put)).not.toContain(VALUE);
  expect(JSON.stringify(put)).toContain("<redacted>");
});

test("names and values security -i could mis-split are refused before anything runs", async () => {
  const bin = shim("never", "exit 0");
  for (const bad of [
    { account: "FRM BACKUP", value: VALUE },
    { account: "FRM_BACKUP_KEY", value: "has space" },
    { account: "FRM_BACKUP_KEY", value: "" },
  ]) {
    expect(
      await putKeychainSecret({
        bin,
        service: "foreman",
        replace: false,
        ...bad,
      }),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  }
  expect(() => readFileSync(join(dir, "never.argv"))).toThrow();
});

test("keychainSecrets puts only the names in argv and reads the value from stdout", async () => {
  const bin = shim("read", `printf '%s\\n' "${VALUE}"`);
  const store = keychainSecrets("foreman", { bin });
  expect(await store.get("FRM_BACKUP_KEY")).toEqual({ ok: true, value: VALUE });
  expect(readFileSync(join(dir, "read.argv"), "utf8")).toBe(
    "find-generic-password\n-s\nforeman\n-a\nFRM_BACKUP_KEY\n-w\n",
  );
  const missing = keychainSecrets("foreman", { bin: shim("miss", "exit 44") });
  expect(await missing.get("FRM_BACKUP_KEY")).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
});

// `security` prints a value it cannot print literally as a bare run of hex digits. The
// fixture above is single-line and hex-shaped, which is exactly why that went unnoticed.
const printing = (name: string, printed: string) =>
  keychainSecrets("foreman", {
    bin: shim(name, `printf '%s\\n' "${printed}"`),
  });

const hexOf = (value: string) => Buffer.from(value, "utf8").toString("hex");

test("a multi-line value printed in security's hex form round-trips byte for byte", async () => {
  const auth = '{\n  "tokens": {"id": "a-b-c"},\n  "last_refresh": 1\n}\n';
  const store = printing("hex-auth", hexOf(auth));
  expect(await store.get("RUNNER_AUTH_JSON")).toEqual({
    ok: true,
    value: auth,
  });
});

test("a hex-shaped value that is not UTF-8 text is passed through literally", async () => {
  // A 32-hex-character API key decodes to 16 bytes of binary, which fails the UTF-8 gate — so it
  // reaches the runner as the characters the operator stored, not as 16 bytes of mojibake.
  const key = "d41d8cd98f00b204e9800998ecf8427e";
  expect(await printing("hex-key", key).get("RUNNER_API_KEY")).toEqual({
    ok: true,
    value: key,
  });
  // Nor is a short hex-shaped value decoded: every byte of "ab" is printable, so `security` would
  // have printed "ab" rather than "6162".
  expect(await printing("hex-short", "6162").get("RUNNER_API_KEY")).toEqual({
    ok: true,
    value: "6162",
  });
});

test("a literal single-line value and odd-length hex are both unchanged", async () => {
  const literal = "sk-live-NotHexAtAll_42";
  expect(await printing("plain", literal).get("RUNNER_API_KEY")).toEqual({
    ok: true,
    value: literal,
  });
  const odd = "0123456789abcde";
  expect(await printing("odd", odd).get("RUNNER_API_KEY")).toEqual({
    ok: true,
    value: odd,
  });
});

test("a hex value that decodes to bytes that are not text is refused, naming only the secret", async () => {
  // A NUL is valid UTF-8 and hex-shaped input decodes to it, but it is not text a runner can use.
  const notText = `tok${String.fromCodePoint(0)}en\nmore`;
  const store = printing("hex-nul", hexOf(notText));
  const got = await store.get("RUNNER_AUTH_JSON");
  expect(got).toMatchObject({
    ok: false,
    error: { class: "validation" },
  });
  const said = JSON.stringify(got);
  expect(said).toContain("RUNNER_AUTH_JSON");
  expect(said).toContain("single line");
  expect(said).not.toContain("tok");
  expect(said).not.toContain("more");
  expect(said).not.toContain(hexOf(notText));
});
