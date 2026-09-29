// The one forge-token rule: delivery's push and the mirror's origin reads share it. A
// token only for an https URL on a forge Bayon implements, and only when the store holds its secret.
import { err, forgeTokenSecret, ok } from "@bayon/core";
import {
  GIT_TOKEN_ENV,
  GIT_TOKEN_HOST_ENV,
  gitTokenFlags,
  type SecretStore,
} from "@bayon/executors";
import { describe, expect, test } from "vitest";
import {
  NO_GIT_AUTH,
  forgeCredential,
  gitAuthOf,
  originGitAuth,
} from "./credential.js";

const TOKEN = "ghp_standin_0123456789";
const HTTPS = "https://github.com/acme/private.git";

/** A store that records the names it was asked for; `values` by name. */
function store(values: Readonly<Record<string, string>> = {}) {
  const asked: string[] = [];
  const s: SecretStore = {
    get: (name) => {
      asked.push(name);
      const value = values[name];
      return Promise.resolve(
        value === undefined
          ? err({
              class: "validation",
              message: `secret ${name} is not in the secret store`,
              retryable: false,
            })
          : ok(value),
      );
    },
  };
  return { s, asked };
}

const withToken = () => store({ [forgeTokenSecret("github")]: TOKEN });

describe("originGitAuth", () => {
  test("an https github origin with the secret in the store is offered the token, by env only", async () => {
    const { s, asked } = withToken();
    const auth = await originGitAuth(s, HTTPS);
    expect(asked).toEqual(["FORGE_TOKEN_GITHUB"]);
    expect(auth.flags).toEqual(gitTokenFlags());
    // The helper answers only for the origin's own host.
    expect(auth.env).toEqual({
      [GIT_TOKEN_ENV]: TOKEN,
      [GIT_TOKEN_HOST_ENV]: "github.com",
    });
    expect(auth.flags.join(" ")).not.toContain(TOKEN);
  });

  test.each([
    ["a local path", "/srv/repos/private"],
    ["a file:// URL", "file:///srv/repos/private"],
    ["an ssh URL", "ssh://git@github.com/acme/private.git"],
    ["an scp-like remote", "git@github.com:acme/private.git"],
    ["a host with no forge kind", "https://git.example.com/acme/private.git"],
    ["plain http", "http://github.com/acme/private.git"],
  ])(
    "%s gets no credential, the store holding the token or not",
    async (_, url) => {
      const { s } = withToken();
      expect(await originGitAuth(s, url)).toEqual(NO_GIT_AUTH);
    },
  );

  test("a store without the secret is no credential, not an error", async () => {
    const { s, asked } = store();
    expect(await originGitAuth(s, HTTPS)).toEqual(NO_GIT_AUTH);
    expect(asked).toEqual(["FORGE_TOKEN_GITHUB"]);
  });

  test("no origin, or no store, asks nothing", async () => {
    const { s, asked } = withToken();
    expect(await originGitAuth(s, null)).toEqual(NO_GIT_AUTH);
    expect(await originGitAuth(undefined, HTTPS)).toEqual(NO_GIT_AUTH);
    expect(asked).toEqual([]);
  });

  test("a non-forge or local remote never reaches the store", async () => {
    const { s, asked } = withToken();
    await originGitAuth(s, "/srv/repos/private");
    await originGitAuth(s, "https://git.example.com/a/b.git");
    expect(asked).toEqual([]);
  });
});

describe("forgeCredential (delivery's view of the same rule)", () => {
  test("an ssh remote on a forge keeps the API token but offers git none", async () => {
    const { s } = withToken();
    const c = await forgeCredential(s, "git@github.com:acme/private.git");
    expect(c.forge?.kind).toBe("github");
    expect(c.token).toBe(TOKEN);
    expect(c.gitToken).toBeNull();
  });

  test("an https remote offers git the same token", async () => {
    const { s } = withToken();
    const c = await forgeCredential(s, HTTPS);
    expect(c).toMatchObject({ token: TOKEN, gitToken: TOKEN });
  });

  test("a forge with no token in the store is named, with no token", async () => {
    const { s } = store();
    const c = await forgeCredential(s, HTTPS);
    expect(c.forge?.kind).toBe("github");
    expect(c).toMatchObject({ token: null, gitToken: null });
  });

  test("forgeOf decides the forge: a URL it maps to nothing is no forge", async () => {
    const { s, asked } = withToken();
    const c = await forgeCredential(s, HTTPS, () => null);
    expect(c).toEqual({ forge: null, token: null, gitToken: null });
    expect(asked).toEqual([]);
  });

  test("gitAuthOf: a null token, or a URL that does not parse, is no credential", () => {
    expect(gitAuthOf(null, HTTPS)).toEqual(NO_GIT_AUTH);
    expect(gitAuthOf(TOKEN, "not a url")).toEqual(NO_GIT_AUTH);
  });
});
