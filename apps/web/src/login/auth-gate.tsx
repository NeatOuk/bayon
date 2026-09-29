import { CircleX, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loading } from "@/components/loading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { onUnauthorized } from "@/api/unauthorized";
import { logout, readSession, type SessionState } from "./auth-api";
import { LoginScreen } from "./login-screen";

type GateState = SessionState | "checking" | "unreachable";

/**
 * Asks the edge who is logged in before the app mounts. Behind the edge: the
 * login screen until a password is accepted, and again on any 401. Under the dev server (`open`):
 * the app as before. `children` gets the logout action, or null when there is no login.
 */
export function AuthGate({
  children,
}: {
  readonly children: (logout: (() => void) | null) => ReactNode;
}) {
  const [state, setState] = useState<GateState>("checking");

  const check = useCallback((signal?: AbortSignal) => {
    setState("checking");
    readSession(signal).then(setState, () => {
      if (!signal?.aborted) setState("unreachable");
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    check(controller.signal);
    return () => controller.abort();
  }, [check]);

  useEffect(
    () =>
      onUnauthorized(() =>
        setState((current) =>
          current === "authenticated" ? "login" : current,
        ),
      ),
    [],
  );

  const doLogout = useCallback(() => {
    void logout().finally(() => setState("login"));
  }, []);

  switch (state) {
    case "checking":
      return <Loading label="Connecting…" className="p-4" />;
    case "unreachable":
      // QueryError's shape, without a query: there is no error object to show, only that nothing came.
      return (
        <div className="p-4">
          <Alert status="error" className="max-w-3xl">
            <CircleX aria-hidden="true" />
            <AlertTitle>The server did not answer.</AlertTitle>
            <AlertDescription>
              <Button size="sm" variant="outline" onClick={() => check()}>
                <RotateCcw aria-hidden="true" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      );
    case "login":
      return <LoginScreen onLoggedIn={() => setState("authenticated")} />;
    case "authenticated":
      return children(doLogout);
    case "open":
      return children(null);
  }
}
