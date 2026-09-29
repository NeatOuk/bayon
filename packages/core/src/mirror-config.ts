// Which repo-local git config keys a mirror may keep, as pure data and one pure plan.
// The supervisor applies it (lifecycle/mirror-config.ts) and the smoke checks a real mirror against
// it (tools/frm smoke), so the table has exactly one source: a second list is a list that goes out
// of date, and the whole point is that nothing is missing from this one.
//
// A mirror's own config is the one git config file environment floor cannot reach, and a
// worktree shares it with its mirror. So every key here either **runs a program** or **decides
// where a fetch goes**, and none of them is a key Bayon itself ever writes.

/** One `key=value` of a repo-local config, as `git config --list` prints it. */
export interface ConfigEntry {
  /** git's own spelling: section and final key lowercased, a subsection's case kept. */
  readonly key: string;
  readonly value: string;
}

/** A key set to exactly one value, or removed however many values it had. */
export type ConfigChange =
  | { readonly op: "set"; readonly key: string; readonly value: string }
  | { readonly op: "unset"; readonly key: string };

/**
 * What every mirror carries. `gc.worktreePruneExpire` is the an earlier change item: SAFE_GIT's auto-
 * maintenance pair only stops the maintenance *our own* calls would trigger, while a plain `git gc`
 * run by anyone else in this mirror reads the mirror's config and would prune the worktree metadata
 * Bayon still depends on.
 */
export const HARDENED_MIRROR_CONFIG: readonly ConfigEntry[] = [
  { key: "gc.worktreePruneExpire", value: "never" },
];

/**
 * What `remote.origin.fetch` is set to when the mirror has an origin (item 3). A
 * `clone --mirror` leaves `+refs/*:refs/*` instead, under which a bare `git fetch` force-updates
 * the mirror's `refs/heads/*` — which here are the live agent branches `git worktree add -b` puts
 * there — and one with `--prune` deletes every ref origin does not have, `refs/frm/pin/*` and
 * `refs/frm/gate/*` among them: the only thing keeping a gate's subject alive. Every fetch Bayon
 * runs names its refspec explicitly (workspace-plan.ts), so nothing of ours reads this value; what
 * it decides is what a fetch with no arguments, run in the mirror by anyone, does.
 */
export const MIRROR_FETCH_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/**
 * Sections in which every key runs a command, redirects a fetch, or decides which *other* file git
 * reads a command out of. Whole sections rather than key lists wherever nothing in the section
 * belongs in a mirror: a list of final keys is a list that can be short one name, and being short
 * one name is how `include.path` slipped past the first cut of this module.
 */
const UNSAFE_SECTIONS: ReadonlySet<string> = new Set([
  // clean / smudge / process run commands on checkout — in every worktree cut from this mirror.
  "filter",
  // insteadOf / pushInsteadOf silently redirect a remote.
  "url",
  // The CRITICAL of the an earlier change review. `include.path` and `includeIf.<cond>.path` name another
  // file whose keys git honours in full, and a `--local` listing does not show them — so with the
  // key itself left in place, every list above is looked up in a file nobody scanned. The key goes,
  // and the apply then re-reads with includes resolved and refuses a mirror that still holds one.
  "include",
  "includeif",
  // A credential helper — plain, or per URL — runs a program on any authenticated transport.
  // Verified against a 401: it runs under the whole environment floor, terminal prompts off and all.
  "credential",
  // proxy, curloptResolve, followRedirects, sslVerify, sslCAInfo: where an https fetch really goes,
  // and whether anything checks who answered.
  "http",
  // A pager is a command, and git runs one for `log`, `diff` and `show` — which agents run
  // themselves, with no -c of ours in front (command-policy.ts).
  "pager",
  // `alias.<x> = !sh -c …` is a shell command; nothing in a mirror needs an alias.
  "alias",
  // <tool>.cmd is a command line, run by difftool / mergetool / guitool.
  "difftool",
  "mergetool",
  "guitool",
  // protocol.<name>.allow is what re-enables the ext:: and fd:: helpers a URL can name.
  "protocol",
  // gpg.program / gpg.<format>.program run on a signed commit or a verify.
  "gpg",
]);

/**
 * Per section, the final key names that run a program, for sections whose other keys are ordinary.
 *
 * The hook path and the fsmonitor are here **as well as** in SAFE_GIT's `-c` pairs, and the
 * earlier claim that the division between the two was exact was wrong: a flag only covers the git
 * *we* run. Agents run git themselves — command-policy.ts grants a builder commit, rebase and merge
 * — and those calls carry no `-c` of ours, in a worktree that shares this file. A hook planted here
 * therefore runs inside another session's process, with that session's environment: §14 secrets and
 * an MCP token (lifecycle/home.ts). `merge.<driver>.driver` and the editor keys are the same story.
 */
const UNSAFE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  core: new Set([
    // Name the transport program, or run one while serving refs.
    "sshcommand",
    "gitproxy",
    "alternaterefscommand",
    // Run a program to answer for a credential, or to page, edit or watch.
    "askpass",
    "pager",
    "editor",
    // The two SAFE_GIT also names, for the git we do not run (see above). Spelled in the lowercase
    // git itself lists them in: the flag spellings live in packages/executors/src/git.ts alone.
    "hookspath",
    "fsmonitor",
  ]),
  // An external diff or a textconv driver runs on `git diff`, which the API does per session.
  diff: new Set(["external", "textconv", "command"]),
  // merge.<driver>.driver is a command line run for a conflicting path on `git merge`.
  merge: new Set(["driver"]),
  // Runs a program while serving a fetch out of this repository.
  uploadpack: new Set(["packobjectshook"]),
  // `git rebase -i` runs it — and a builder is granted rebase.
  sequence: new Set(["editor"]),
  // Name a program to run for that remote, or another place to fetch from and push to. The remote
  // section is reconciled whole below; these are named so `unsafeMirrorKey` alone still refuses them.
  remote: new Set(["uploadpack", "receivepack", "proxy", "pushurl"]),
};

/**
 * The only two repo-local `remote.*` keys a mirror may hold: its origin's URL, which is reconciled
 * against `repos.origin_url`, and the narrow fetch refspec. Everything else under `remote.` goes —
 * `mirror` (a plain push would push every ref with deletions), `tagOpt`, `pushurl`, `proxy`, a
 * second remote entirely. The rule is an allowlist because this section is wholly ours: nothing
 * else writes it, so nothing legitimate can be lost, and no future `remote.*` key can be missed.
 */
const KEPT_REMOTE_KEYS: ReadonlySet<string> = new Set([
  "remote.origin.url",
  "remote.origin.fetch",
]);

/**
 * git's key grammar: the first segment is the section, the last the key, anything between them the
 * subsection — which may itself hold dots (a URL base does).
 */
function sectionAndKey(key: string): { section: string; last: string } {
  const first = key.indexOf(".");
  if (first === -1) return { section: key.toLowerCase(), last: "" };
  return {
    section: key.slice(0, first).toLowerCase(),
    last: key.slice(key.lastIndexOf(".") + 1).toLowerCase(),
  };
}

/**
 * A config key with its subsection replaced by `*`, for a log line or an error message.
 *
 * Values are never logged, but for `url.<base>.insteadOf` the base **is** the key, and
 * `https://x-access-token:<token>@github.com/` is its common spelling — a credential in a key
 * (Invariant 11). The section and the final key are what a reader needs; the middle is not.
 */
export function redactedConfigKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first === -1 || first === last) return key;
  return `${key.slice(0, first)}.*.${key.slice(last + 1)}`;
}

/** Whether a repo-local key runs a program or redirects a remote, and so is removed from a mirror. */
export function unsafeMirrorKey(key: string): boolean {
  const { section, last } = sectionAndKey(key);
  if (UNSAFE_SECTIONS.has(section)) return true;
  if (section === "remote" && !KEPT_REMOTE_KEYS.has(key.toLowerCase())) {
    return true;
  }
  return UNSAFE_KEYS[section]?.has(last) ?? false;
}

/** `git config --list -z`: entries are NUL-separated, key and value split by the first newline. */
export function parseConfigList(text: string): readonly ConfigEntry[] {
  return text
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const nl = entry.indexOf("\n");
      return nl === -1
        ? { key: entry, value: "" } // a key declared with no value at all
        : { key: entry.slice(0, nl), value: entry.slice(nl + 1) };
    });
}

/** What `plannedMirrorConfig` needs to know beyond the config it is looking at. */
export interface MirrorConfigWanted {
  /**
   * `repos.origin_url`, the URL this mirror's origin must point at, or null when the repo row
   * names none. A mirror with no declared origin keeps whatever URL it has — nothing Bayon runs
   * fetches from it — but it is still given no fetch refspec.
   */
  readonly originUrl: string | null;
}

/**
 * What `local` must change by, or `[]` when the mirror is already hardened — which is what makes a
 * second pass write nothing at all. Unsets first, by git's own spelling of the key, then the sets.
 *
 * Run it a second time over the config git reports **with includes resolved**: that it plans nothing
 * there is the actual claim ("this mirror can run no command and redirect no fetch"), where a first
 * pass over the local file alone only says "the keys we know of are gone from the file we read".
 */
export function plannedMirrorConfig(
  local: readonly ConfigEntry[],
  wanted: MirrorConfigWanted,
): readonly ConfigChange[] {
  const remove = new Set<string>();
  for (const { key } of local) {
    if (unsafeMirrorKey(key)) remove.add(key);
  }
  const valuesOf = (key: string): string[] =>
    local.filter((e) => e.key === key).map((e) => e.value);
  const alreadySet = (key: string, value: string): boolean => {
    const values = valuesOf(key);
    return values.length === 1 && values[0] === value;
  };
  const want: ConfigEntry[] = [...HARDENED_MIRROR_CONFIG];
  // A mirror with no origin (a repo row with no origin_url) has no remote to reconcile.
  if (wanted.originUrl !== null) {
    want.push(
      { key: "remote.origin.url", value: wanted.originUrl },
      { key: "remote.origin.fetch", value: MIRROR_FETCH_REFSPEC },
    );
  }
  return [
    ...[...remove].sort().map((key) => ({ op: "unset", key }) as const),
    ...want
      .filter(({ key, value }) => !alreadySet(key.toLowerCase(), value))
      .map(({ key, value }) => ({ op: "set", key, value }) as const),
  ];
}

/**
 * The removals alone, for a config file that is not the mirror's shared one: a per-worktree
 * `config.worktree`, which `extensions.worktreeConfig` makes git read and which the shared file's
 * pass never sees. Nothing is *written* to such a file — the keys a mirror must carry belong in the
 * one config every worktree shares.
 */
export function plannedConfigRemovals(
  entries: readonly ConfigEntry[],
): readonly ConfigChange[] {
  const remove = new Set<string>();
  for (const { key } of entries) {
    if (unsafeMirrorKey(key)) remove.add(key);
  }
  return [...remove].sort().map((key) => ({ op: "unset", key }) as const);
}
