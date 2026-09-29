// §5.1 `concurrentSessions` for a runner whose answer depends on the credential a session resolved
//. The declared value is a pure function of the credentials the runner says a session
// may resolve onto, so the caps a certification is keyed on never move between boots because of
// what the host's secret store happens to hold that morning.
import { capsHash, readsGrantedLogin } from "@bayon/core";
import { expect, test } from "vitest";
import { API_KEY_ENV, AUTH_JSON_ENV } from "./home.js";
import {
  CAPS,
  DEFAULTS,
  RUNNER_ID,
  SECRET_ENV_ANY_OF,
  concurrentSessionsOf,
  registration,
} from "./registration.js";

test("auth.json among the alternatives declares the narrower value: one session at a time", () => {
  expect(concurrentSessionsOf([[API_KEY_ENV], [AUTH_JSON_ENV]])).toBe(false);
  expect(concurrentSessionsOf([[AUTH_JSON_ENV]])).toBe(false);
  expect(CAPS.concurrentSessions).toBe(false);
  expect(registration().runner.caps.concurrentSessions).toBe(false);
});

test("the wider value only when it is certain: no alternative serves one session", () => {
  expect(concurrentSessionsOf([[API_KEY_ENV]])).toBe(true);
  expect(concurrentSessionsOf([])).toBe(true);
});

test("the cap reads the very alternatives the runner row declares", () => {
  expect(DEFAULTS.secretEnvAnyOf).toBe(SECRET_ENV_ANY_OF);
  expect(CAPS.concurrentSessions).toBe(
    concurrentSessionsOf(DEFAULTS.secretEnvAnyOf),
  );
});

test("the declared caps are static: two registrations hash the same (no boot-time drift)", async () => {
  const a = await capsHash(registration().runner.caps);
  const b = await capsHash(registration().runner.caps);
  expect(a).toBe(b);
  // Widening is a change to these rows, and it lapses the certification once, on purpose.
  const wider = { ...CAPS, concurrentSessions: true };
  expect(await capsHash(wider)).not.toBe(a);
  expect(RUNNER_ID).toBe("codex-exec");
});

test("it declares that it reads a login granted in place: the one adapter that places the file and writes it back", () => {
  expect(readsGrantedLogin(DEFAULTS)).toBe(true);
  expect(readsGrantedLogin(registration().runner.defaults)).toBe(true);
});
