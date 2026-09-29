import { z } from "zod";

// Which host store a secret is read from, as the secret-status views report it: names
// only, never a value.

/** The Mac's Keychain, or the docker host's files. */
export const SecretStoreKindView = z.enum(["keychain", "file"]);
export type SecretStoreKindView = z.infer<typeof SecretStoreKindView>;

/**
 * The Keychain service this install reads: `foreman` for the account's default home (`owner`), a
 * service derived from the home for any other install. Null with the file store.
 */
export const KeychainScopeView = z.object({
  service: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  owner: z.boolean(),
});
export type KeychainScopeView = z.infer<typeof KeychainScopeView>;
