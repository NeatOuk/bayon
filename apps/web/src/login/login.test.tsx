import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { notifyUnauthorized } from "@/api/unauthorized";
import { AuthGate } from "./auth-gate";
import { LoginScreen } from "./login-screen";

// The GUI side of the login: the gate asks /auth/me, shows the login screen
// behind the edge, opens the app under the dev server, and returns to the login on any 401.
afterEach(() => {
  vi.unstubAllGlobals();
});

type Route = (url: string, init?: RequestInit) => Response;

function stubFetch(route: Route) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    route(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const apiError = (status: number, message: string) =>
  json(status, { error: { class: "validation", message, retryable: false } });

describe("LoginScreen", () => {
  test("sends the password once and reports success", async () => {
    const fetchMock = stubFetch(() => json(200, { authenticated: true }));
    const onLoggedIn = vi.fn();
    render(<LoginScreen onLoggedIn={onLoggedIn} />);
    await userEvent.type(
      screen.getByLabelText("Password"),
      "correct-horse-battery-staple",
    );
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ password: "correct-horse-battery-staple" }),
      }),
    );
  });

  test("a wrong password and a rate limit are shown, not thrown", async () => {
    let status = 401;
    stubFetch(() =>
      status === 401
        ? apiError(401, "wrong password")
        : apiError(429, "too many login attempts: try again in 900 s"),
    );
    render(<LoginScreen onLoggedIn={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Wrong password.",
    );
    status = 429;
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "try again in 900 s",
      ),
    );
  });

  test("an empty password is caught before any request", async () => {
    const fetchMock = stubFetch(() => json(200, {}));
    render(<LoginScreen onLoggedIn={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter the password.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AuthGate", () => {
  const app = (logout: (() => void) | null) => (
    <p>{logout === null ? "the app, no login" : "the app, logged in"}</p>
  );

  test("behind the edge with no session: the login screen, then the app", async () => {
    let loggedIn = false;
    stubFetch((url) => {
      if (url === "/auth/login") {
        loggedIn = true;
        return json(200, { authenticated: true });
      }
      return loggedIn
        ? json(200, { authenticated: true })
        : apiError(401, "login required");
    });
    render(<AuthGate>{app}</AuthGate>);
    await userEvent.type(
      await screen.findByLabelText("Password"),
      "correct-horse-battery-staple",
    );
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    // findBy* throws when the element never appears: finding it is the assertion.
    expect(await screen.findByText("the app, logged in")).toBeTruthy();
  });

  test("under the dev server (/auth/me is no JSON answer): the app opens with no login", async () => {
    stubFetch(() => new Response("<!doctype html>", { status: 200 }));
    render(<AuthGate>{app}</AuthGate>);
    expect(await screen.findByText("the app, no login")).toBeTruthy();
  });

  test("a 401 anywhere returns to the login screen", async () => {
    stubFetch(() => json(200, { authenticated: true }));
    render(<AuthGate>{app}</AuthGate>);
    expect(await screen.findByText("the app, logged in")).toBeTruthy();
    notifyUnauthorized();
    expect(await screen.findByLabelText("Password")).toBeTruthy();
  });

  test("an unreachable server offers a retry", async () => {
    let up = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!up) throw new TypeError("network down");
        return json(200, { authenticated: true });
      }),
    );
    render(<AuthGate>{app}</AuthGate>);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "did not answer",
    );
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("the app, logged in")).toBeTruthy();
  });
});
