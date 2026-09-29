import { vi } from "vitest";

// React's warnings about updates it could not schedule well, as console.error reports them: a
// flushSync inside a render or commit, and an update a test did not wrap in act. A test that must
// not provoke them spies with this and asserts the list is empty.

const REACT_WARNING =
  /flushSync was called from inside a lifecycle method|not wrapped in act/;

/** Starts watching console.error; the returned function lists React's scheduling warnings so far. */
export function watchReactWarnings(): () => string[] {
  const spy = vi.spyOn(console, "error");
  return () =>
    spy.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((message) => REACT_WARNING.test(message));
}
