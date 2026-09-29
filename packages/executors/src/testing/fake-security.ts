// A stand-in for macOS `security` over a directory of items (one file per service.account), for
// tests that must store and read a Keychain secret without ever reaching the real Keychain. Every
// argv is appended to argv.log, so a test can prove a value never reached a command line.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeSecurity {
  /** The stand-in binary: pass it as `{ keychain: { bin } }`. */
  readonly bin: string;
  /** The items: `<service>.<account>`, the value as the file's content. */
  readonly kc: string;
  /** Every argv the stand-in saw, one line each. */
  readonly argv: string;
}

export function installFakeSecurity(dir: string): FakeSecurity {
  const kc = join(dir, "kc");
  mkdirSync(kc, { recursive: true });
  const bin = join(dir, "security");
  const argv = join(dir, "argv.log");
  writeFileSync(
    bin,
    `${[
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${argv}"`,
      'if [ "$1" = "-i" ]; then IFS= read -r line; set -- $line; fi',
      'cmd="$1"; shift',
      'update=0; svc=""; acct=""; val=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      "    -U) update=1 ;;",
      '    -s) svc="$2"; shift ;;',
      '    -a) acct="$2"; shift ;;',
      '    -w) if [ $# -gt 1 ]; then val="$2"; shift; fi ;;',
      "  esac",
      "  shift",
      "done",
      `item="${kc}/$svc.$acct"`,
      'case "$cmd" in',
      '  find-generic-password) [ -f "$item" ] || exit 44; cat "$item"; echo ;;',
      '  add-generic-password) if [ -f "$item" ] && [ "$update" = 0 ]; then echo "exists" >&2; exit 45; fi; printf "%s" "$val" > "$item" ;;',
      "  *) exit 2 ;;",
      "esac",
    ].join("\n")}\n`,
  );
  chmodSync(bin, 0o700);
  writeFileSync(argv, "");
  return { bin, kc, argv };
}
