import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { login } from "./auth-api";

/** The operator's login: one password, sent once; the edge sets the cookie. */
export function LoginScreen({
  onLoggedIn,
}: {
  readonly onLoggedIn: () => void;
}) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password === "") {
      setError("Enter the password.");
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await login(password);
    setPending(false);
    if (outcome.ok) {
      setPassword("");
      onLoggedIn();
    } else {
      setError(outcome.message);
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <form onSubmit={(event) => void submit(event)} noValidate>
          <CardHeader>
            <CardTitle as="h1" className="font-head tracking-wide">
              BAYON
            </CardTitle>
            <CardDescription>Log in to operate the fleet.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 py-4">
            <Label htmlFor={inputId}>Password</Label>
            <Input
              id={inputId}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error !== null}
            />
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? "Logging in…" : "Log in"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
