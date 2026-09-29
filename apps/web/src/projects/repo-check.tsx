import type { RepoCheckView } from "@bayon/proto";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyCommand } from "@/notify/copy-command";

// What New project found about a https or ssh repo URL before creating anything: the
// supervisor read it the way the first session's clone will. Plain words: found and its default
// branch, or what happened and the one thing to do, with the command when there is one.

const TITLE: Readonly<Record<string, string>> = {
  missing: "Bayon cannot read this repository.",
  host_key: "This machine does not trust that host yet.",
  unreachable: "Bayon cannot reach that host.",
  timeout: "That host did not answer.",
  failed: "git could not read this repository.",
  found: "That branch is not in this repository.",
};

export function RepoCheckPanel({ check }: { readonly check: RepoCheckView }) {
  if (check.ok) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {check.message}
      </p>
    );
  }
  if (check.outcome === null) {
    return (
      <Alert status="info" role="status">
        <AlertTitle>The repository was not checked.</AlertTitle>
        <AlertDescription>{check.message}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert status="warning" role="status">
      <AlertTitle>{TITLE[check.outcome] ?? ""}</AlertTitle>
      <AlertDescription>
        <p>{check.message}</p>
        {check.command !== null && (
          <CopyCommand
            command={check.command}
            label="the command that fixes it"
          />
        )}
      </AlertDescription>
    </Alert>
  );
}
