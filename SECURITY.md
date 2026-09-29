# Security

To report a vulnerability, open a
[GitHub Security Advisory](https://github.com/NeatOuk/bayon/security/advisories/new) rather
than a public issue.

## How secrets are handled here

Per `CLAUDE.md` Invariant 11: secrets come from the host secret store into a child process's
environment at spawn time. They are never written to the database, a prompt, an event payload, a
worktree, or a log.

- **Local (`~/.foreman`):** the macOS Keychain, via `security add-generic-password`/
  `find-generic-password`, service `foreman`. The service belongs to one install: only the
  account's default home (`~/.foreman`, compared by real path, with the home directory taken from
  the account rather than `$HOME`) reads `foreman`; any other `FRM_HOME` reads
  `foreman-<first 12 hex of the SHA-256 of its real path>`, with no fallback to `foreman`. A
  scratch instance, a smoke or a test rig therefore never reads the live install's secrets. The
  test suite runs with a stand-in `security` first on `PATH`.
- **A docker host:** there is none today (see `CLAUDE.md`'s Status block), so nothing is stored this
  way at present. When one existed, it was a file-backed store under `/srv/bayon/<project>/secrets/`,
  managed by `deploy/secrets.sh` — `list` printed names, owners, modes and sizes, never a value. The
  same shape applies again if a host is ever registered.

If a secret is ever exposed (committed, logged, or printed), rotate it — don't just delete the
occurrence. Git history keeps it.

## Reporting other issues

A CRITICAL/HIGH finding from a code review agent is fixed before the PR merges — see the
"Definition of done" in `CLAUDE.md`. For anything a human should look at directly, use the security
advisory link above.
