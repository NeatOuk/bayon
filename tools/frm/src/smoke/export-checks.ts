// The markdown export's checks (M1 close, contract 6): pure, each returning what is wrong.

/** The `status:` in a markdown export's YAML frontmatter, and nowhere else; undefined if none. */
export function frontmatterStatus(md: string): string | undefined {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1];
  if (block === undefined) return undefined;
  const status = /^status: *(.+?) *$/m.exec(block)?.[1];
  return status?.replace(/^(["'])(.*)\1$/, "$2");
}

/** One ticket's export: its ticket_exports row, and the file that row points at. */
export interface ExportedFile {
  readonly key: string;
  /** The ticket's status in the DB. */
  readonly dbStatus: string;
  readonly row:
    | {
        readonly path: string | null;
        readonly content_hash: string | null;
        readonly state: string;
      }
    | undefined;
  /** The file's text, or undefined when it is not in the exports repo. */
  readonly text: string | undefined;
  /** sha256 of the file's text. */
  readonly sha256: string | undefined;
}

/** At tickets/<KEY>.md, synced, its frontmatter status the DB's, its content_hash the file's. */
export function exportedFileProblems(f: ExportedFile): string[] {
  if (f.row === undefined) return [`${f.key}: no ticket_exports row`];
  const expected = `tickets/${f.key}.md`;
  if (f.text === undefined)
    return [`${f.key}: ${f.row.path ?? expected} is not in the exports repo`];
  const status = frontmatterStatus(f.text);
  return [
    ...(f.row.path === expected
      ? []
      : [`${f.key}: exported to ${f.row.path}, expected ${expected}`]),
    ...(f.row.state === "synced"
      ? []
      : [`${f.key}: ticket_exports state ${f.row.state}, expected synced`]),
    ...(status === f.dbStatus
      ? []
      : [
          `${f.key}: frontmatter status ${status ?? "missing"}, the DB says ${f.dbStatus}`,
        ]),
    ...(f.sha256 === f.row.content_hash
      ? []
      : [
          `${f.key}: the file hashes to ${f.sha256}, ticket_exports says ${f.row.content_hash}`,
        ]),
  ];
}
