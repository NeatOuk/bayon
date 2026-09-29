import { expect, test } from "vitest";
import { deliverySecrets, scrubToken, urlCredentials } from "./scrub.js";

// MEDIUM 1. Two secrets can reach a delivery's messages: the forge token
// from the host store, and a credential the project's own remote URL carries — `checkOriginUrl`
// accepts `https://user:token@host/path`, and git echoes the remote it could not reach.

const TOKEN = "a-secret-forge-token";

test("a token is scrubbed in every form it could have been written in", () => {
  const b64 = Buffer.from(TOKEN).toString("base64");
  const said = [
    TOKEN,
    b64,
    b64.replace(/=+$/, ""),
    Buffer.from(TOKEN).toString("base64url"),
    encodeURIComponent(TOKEN),
    `Bearer ${TOKEN}`,
    Buffer.from(`x-access-token:${TOKEN}`).toString("base64"),
  ].join(" | ");
  const clean = scrubToken(said, TOKEN);
  expect(clean).not.toContain(TOKEN);
  expect(clean).not.toContain(b64);
  expect(clean).toContain("<redacted>");
});

test("a remote's credential is the secret; its host and path are not", () => {
  const parts = urlCredentials(
    "https://ops:s3cr3t@forge.test/an-owner/a-repo.git",
  );
  expect(parts).toContain("s3cr3t");
  expect(parts).toContain("ops:s3cr3t");
  expect(parts.join(" ")).not.toContain("forge.test");
  expect(parts.join(" ")).not.toContain("a-repo");
});

test("a %-encoded credential is scrubbed decoded as well as raw", () => {
  const parts = urlCredentials("https://ops:a%20b%3Ac@forge.test/o/r.git");
  expect(parts).toContain("a%20b%3Ac");
  expect(parts).toContain("a b:c");
});

test("a remote with no credential, and one that is not a URL, contribute nothing", () => {
  expect(urlCredentials("https://forge.test/an-owner/a-repo.git")).toEqual([]);
  expect(urlCredentials("/srv/mirrors/a-repo.git")).toEqual([]);
  expect(urlCredentials("git@forge.test:o/r.git")).toEqual([]);
});

test("deliverySecrets takes both, and copes with either being absent", () => {
  const both = deliverySecrets(TOKEN, "https://ops:s3cr3t@forge.test/o/r.git");
  expect(both).toContain(TOKEN);
  expect(both).toContain("s3cr3t");
  expect(deliverySecrets(null, "https://forge.test/o/r.git")).toEqual([]);
  expect(deliverySecrets(TOKEN, "")).toEqual([
    TOKEN,
    `Bearer ${TOKEN}`,
    `x-access-token:${TOKEN}`,
  ]);
});
