import { afterEach, expect, test } from "vitest";
import {
  clearLeaseToken,
  isLeaseHolderFor,
  readLeaseToken,
  writeLeaseToken,
} from "@/session/pty-lease-storage";

afterEach(() => sessionStorage.clear());

test("this tab is the holder once its own attach's token matches the polled owner", () => {
  writeLeaseToken("s1", "my-token");
  expect(isLeaseHolderFor("s1", "my-token")).toBe(true);
});

test("a different actor's token never reads as this tab holding the lease, even after this tab also attached", () => {
  // own code review: adopting "whatever lease owner shows up next" raced a different
  // actor's attach and produced a false positive here. Comparing this tab's own known token can't.
  writeLeaseToken("s1", "my-token");
  expect(isLeaseHolderFor("s1", "someone-elses-token")).toBe(false);
});

test("no persisted token, or no current lease owner at all, is never the holder", () => {
  expect(isLeaseHolderFor("s1", "anything")).toBe(false);
  writeLeaseToken("s1", "my-token");
  expect(isLeaseHolderFor("s1", null)).toBe(false);
});

test("a reload recognizes a legitimate holder immediately: the token was already in storage before this call", () => {
  // No React state to lose on reload — writeLeaseToken (a prior page's own attach) is read back
  // exactly like any other call, no special "was I attaching" flag needed.
  writeLeaseToken("s1", "my-token");
  expect(isLeaseHolderFor("s1", "my-token")).toBe(true);
});

test("clearing removes the token", () => {
  writeLeaseToken("s1", "my-token");
  clearLeaseToken("s1");
  expect(readLeaseToken("s1")).toBeNull();
  expect(isLeaseHolderFor("s1", "my-token")).toBe(false);
});

test("tokens are scoped per session id", () => {
  writeLeaseToken("s1", "token-1");
  writeLeaseToken("s2", "token-2");
  expect(isLeaseHolderFor("s1", "token-2")).toBe(false);
  expect(isLeaseHolderFor("s2", "token-2")).toBe(true);
});
