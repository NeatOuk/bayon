import { useState } from "react";
import { Button } from "@/components/ui/button";

// A shell command the operator runs to store a secret, selectable whole and copyable (// the pattern jira-token-step.tsx set). The GUI never asks for the secret itself: it only says
// where to put it.

type Copied = "idle" | "copied" | "insecure" | "failed";

const COPIED: Readonly<Record<Copied, string>> = {
  idle: "",
  copied: "Copied.",
  // No clipboard outside a secure context: a LAN page over plain http.
  insecure: "Copying needs https or localhost: select the command and copy it.",
  failed: "Could not copy: select the command and copy it.",
};

export function CopyCommand({
  command,
  label,
}: {
  readonly command: string;
  readonly label: string;
}) {
  const [copied, setCopied] = useState<Copied>("idle");
  const copy = async () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setCopied("insecure");
      return;
    }
    try {
      await clipboard.writeText(command);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded-md border bg-muted px-2 py-1 font-mono text-xs break-all select-all [font-variant-ligatures:none]">
          {command}
        </code>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`Copy ${label}`}
          onClick={() => void copy()}
        >
          Copy
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {COPIED[copied]}
      </p>
    </div>
  );
}
