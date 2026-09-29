// hash-password: reads the password on stdin and writes only its scrypt hash
// on stdout. Neither may be a terminal: deploy/secrets.sh reads the password from the operator's TTY
// without echo (or generates it) and pipes it in, then stores the hash. Never argv, a file or a log.
import { pathToFileURL } from "node:url";
import { err, ok, type Result } from "@bayon/core";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./password.js";

const MAX_INPUT_BYTES = 2 * 1024;

const refuse = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/** One line: its line end stripped (an ssh TTY may send CR LF), at least 20 characters. */
export async function hashFromInput(
  input: string,
  o: { readonly logN?: number } = {},
): Promise<Result<string>> {
  const password = input.replace(/\r?\n$/, "").replace(/\r$/, "");
  if (/[\r\n]/.test(password)) return refuse("the password must be one line");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return refuse(
      `the password needs at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return refuse(
      `the password may have at most ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
  return ok(await hashPassword(password, o));
}

async function readStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  if (process.stdin.isTTY || process.stdout.isTTY) {
    process.stderr.write(
      "hash-password: pipe the password in and the hash out (deploy/secrets.sh password does); never a terminal\n",
    );
    return 2;
  }
  const input = await readStdin();
  if (input === null) {
    process.stderr.write("hash-password: the input is too long\n");
    return 1;
  }
  const hashed = await hashFromInput(input);
  if (!hashed.ok) {
    process.stderr.write(`hash-password: ${hashed.error.message}\n`);
    return 1;
  }
  process.stdout.write(`${hashed.value}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`hash-password: ${String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
