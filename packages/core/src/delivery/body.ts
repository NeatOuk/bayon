// A pull request's title and body (spike §1.8), compiled in one place rather than
// concatenated at the call site. Pure: facts in, text out, so what a PR says is table-testable and
// the network code has no prose in it.
//
// It names nothing of anyone's: the ticket's own key and title, the branch, and — for the parent of
// a submodule project — the gitlink bump, so a reviewer reading the parent knows which child pull
// requests it is pinned to.
//
// **Ticket text is not trusted here** (security review, MEDIUM 2). A title or an
// acceptance note can be agent-authored or mirrored in from a tracker, and this text is posted on a
// real repository under Bayon's own token. Two things are therefore neutralised before composing:
//
//   * a **mention** — `@name`, `@org/team` — would ping real people and real teams. A zero-width
//     space (U+200B) is inserted after any `@` that starts one. It was chosen over backticks
//     because a pull request *title* is plain text on every forge, so backticks would show up as
//     literal characters there while doing nothing; the zero-width space reads identically in a
//     title and in a body and leaves the words themselves intact. An `@` inside a word (an email
//     address) is left alone: no forge linkifies that one.
//   * an **HTML comment** — `<!-- … -->` renders as nothing at all, so it is where an instruction
//     aimed at whoever (or whatever) reads the pull request would be hidden. It is removed.
//
// Bayon's own structure — the gitlink list, the links, the headings — is composed here and is never
// passed through either of these.

/** How much of a field reaches a PR: a forge has its own limits, and a body is not a log. */
export const PR_TITLE_MAX = 200;
export const PR_BODY_MAX = 8_000;
/** How much of one ticket field the body quotes. */
const FIELD_MAX = 2_000;
const SHA_SHORT = 12;

/** One submodule this parent's commit pins, as the body lists it. */
export interface DeliveredSubmodule {
  /** Its path from the superproject's root, as `workspace_repos.submodule_path` spells it. */
  readonly path: string;
  readonly branch: string;
  readonly sha: string;
  /** Its own pull request, when one was opened; null when the mode is `push`, or none could be. */
  readonly pr_url: string | null;
}

export interface PullRequestFacts {
  /** The ticket's key, as every door spells one. */
  readonly key: string;
  readonly title: string;
  /** The branch being delivered. */
  readonly branch: string;
  /** Its base: that repo's own `repos.default_base_branch`. */
  readonly base: string;
  /** The ticket's acceptance text, quoted; empty when it has none. */
  readonly acceptance: string;
  /** The submodules this commit pins; empty for every repo but a superproject's parent. */
  readonly submodules: readonly DeliveredSubmodule[];
}

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** U+200B: invisible, and enough to stop a forge reading `@name` as a mention. */
const ZERO_WIDTH_SPACE = "\u200b";
/** An `@` that starts a mention: at a word boundary, followed by a name character. */
const MENTION = /(^|[^\w@])@(?=[A-Za-z0-9])/g;
/** `<!-- … -->`, including one that never closes — the tail is hidden just the same. */
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * Ticket text made safe to post: HTML comments removed, mentions defused. Never applied to Bayon's
 * own words — only to what came in on the ticket.
 */
export const safeTicketText = (text: string): string =>
  text.replace(HTML_COMMENT, "").replace(MENTION, `$1@${ZERO_WIDTH_SPACE}`);

/** `<key> <title>`, the title defused and capped — a forge refuses a title past its own limit. */
export const pullRequestTitle = (f: PullRequestFacts): string =>
  cut(`${f.key} ${safeTicketText(f.title)}`.trim(), PR_TITLE_MAX);

const bump = (s: DeliveredSubmodule): string => {
  const sha = s.sha.slice(0, SHA_SHORT);
  const where = s.pr_url === null ? s.branch : `${s.branch} — ${s.pr_url}`;
  return `- \`${s.path}\` → \`${sha}\` (${where})`;
};

/**
 * The body: what the ticket is, where the change came from, and the gitlink bump when there is one.
 * Capped at PR_BODY_MAX, so a ticket with a long acceptance never produces an unbounded request
 * body (Invariant 9's rule, applied to what we send rather than to what we read).
 */
export function pullRequestBody(f: PullRequestFacts): string {
  const acceptance = safeTicketText(f.acceptance).trim();
  const title = safeTicketText(f.title).trim();
  const parts = [
    `Delivered by Bayon for **${f.key}** — ${cut(title, FIELD_MAX)}`,
    `Branch \`${f.branch}\` onto \`${f.base}\`.`,
    ...(acceptance === ""
      ? []
      : [`## Acceptance\n\n${cut(acceptance, FIELD_MAX)}`]),
    ...(f.submodules.length === 0
      ? []
      : [
          `## Submodules\n\nThis commit pins:\n\n${f.submodules
            .map(bump)
            .join("\n")}\n\nMerge those first.`,
        ]),
  ];
  return cut(parts.join("\n\n"), PR_BODY_MAX);
}
