import { canonicalJson, type JsonValue } from "./canonical-json.js";

const utf8 = new TextEncoder();

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. Web Crypto, so it runs in the browser too. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** `prompt_hash` (§8.1): the exact prompt text. Whitespace and line endings count; the model sees them. */
export const hashPrompt = (prompt: string): Promise<string> =>
  sha256Hex(prompt);

/** `config_hash` (§8.1): canonical JSON, so key order and source formatting never matter. */
export const hashConfig = (config: JsonValue): Promise<string> =>
  sha256Hex(canonicalJson(config));

export interface DoctrineFile {
  readonly path: string;
  readonly content: string;
}

/**
 * `doctrine_hash` (§8.1): hashes the set of doctrine files actually loaded, not the repo sha.
 * It is SHA-256 over the sorted records `<UTF-8 byte length of path>:<path><sha256 of content>`.
 * Paths are normalized to NFC and content line endings to LF. Load order does not matter. Editing,
 * renaming, adding or removing a file changes the hash.
 */
export async function hashDoctrine(
  files: readonly DoctrineFile[],
): Promise<string> {
  const records = await Promise.all(
    files.map(async ({ path, content }) => {
      const nfcPath = path.normalize("NFC");
      const digest = await sha256Hex(content.replace(/\r\n?/g, "\n"));
      return `${utf8.encode(nfcPath).length}:${nfcPath}${digest}`;
    }),
  );
  return sha256Hex(records.toSorted().join(""));
}

export interface ToolDefinition {
  readonly name: string;
  readonly schema: JsonValue;
}

/**
 * `toolset_hash` (§8.1): tool names plus their schemas. It hashes the canonical JSON array of
 * `[name, schema]` pairs, sorted, so tool order and schema key order do not matter.
 */
export const hashToolset = (
  tools: readonly ToolDefinition[],
): Promise<string> =>
  sha256Hex(
    `[${tools
      .map((tool) => canonicalJson([tool.name, tool.schema]))
      .toSorted()
      .join(",")}]`,
  );
