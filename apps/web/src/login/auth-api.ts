import { ApiErrorBody } from "@bayon/proto";
import { z } from "zod";

// The production edge server's login: /auth/me, /auth/login, /auth/logout on
// the page's own origin. Under the Vite dev server there is no edge and no login: /auth/me is not a
// JSON answer there, and the app opens as before.

/** `authenticated`: logged in behind the edge; `login`: the edge wants a password; `open`: no edge. */
export type SessionState = "authenticated" | "login" | "open";

const Me = z.object({ authenticated: z.literal(true) });

export async function readSession(signal?: AbortSignal): Promise<SessionState> {
  const response = await fetch("/auth/me", {
    signal,
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return "login";
  if (!response.ok) return "open";
  const body = await response.json().catch(() => undefined);
  return Me.safeParse(body).success ? "authenticated" : "open";
}

export type LoginOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

const messageOf = async (response: Response): Promise<string> => {
  const body = ApiErrorBody.safeParse(
    await response.json().catch(() => undefined),
  );
  if (response.status === 401) return "Wrong password.";
  return body.success
    ? body.data.error.message
    : `The server answered HTTP ${response.status}.`;
};

export async function login(password: string): Promise<LoginOutcome> {
  let response: Response;
  try {
    response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, message: "The server did not answer." };
  }
  return response.ok
    ? { ok: true }
    : { ok: false, message: await messageOf(response) };
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" }).catch(() => undefined);
}
