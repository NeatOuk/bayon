import type { FolderAllowScope, FolderCheck } from "@bayon/proto";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { RadioChoices } from "@/components/radio-choices";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { notify } from "@/components/ui/toast";
import { CopyCommand } from "@/notify/copy-command";
import { refusalMessage } from "@/notify/notify-api";
import { allowFolder, initFolder } from "@/projects/folders-api";

// What New project found about a folder, and the one thing to do about it.
// Plain words throughout: what happened, then one action. Allowing a folder is offered only when the
// server says this browser is on the Bayon host (`check.local`); anywhere else the page shows the
// shell command to run there. `onChanged` runs after an action succeeds: the form checks again and,
// when the folder is ready, creates the project.

interface PanelProps {
  readonly check: FolderCheck;
  readonly onChanged: () => void;
}

/** The notice for `check`; nothing when the folder is ready. */
export function FolderPanel({ check, onChanged }: PanelProps) {
  switch (check.state) {
    case "ready":
      return null;
    case "not_allowed":
      return check.local && check.real_path !== null ? (
        <AllowHere
          check={check}
          realPath={check.real_path}
          onChanged={onChanged}
        />
      ) : (
        <AllowElsewhere command={check.allow_command} />
      );
    case "missing":
      return (
        <Alert status="warning" role="status">
          <AlertTitle>{`There is no folder at ${check.path}.`}</AlertTitle>
          <AlertDescription>
            Check the path, or create the folder first.
          </AlertDescription>
        </Alert>
      );
    case "foreign_repo":
      return (
        <Alert status="warning" role="status">
          <AlertTitle>
            This folder&apos;s .git belongs to another repository, or is broken.
          </AlertTitle>
          <AlertDescription>
            Bayon leaves it alone. Fix or remove that .git in a terminal, then
            press Create again.
          </AlertDescription>
        </Alert>
      );
    case "unborn_head":
      return (
        <Alert status="warning" role="status">
          <AlertTitle>
            {`This repository's current branch, ${check.branch ?? "HEAD"}, has no commits yet.`}
          </AlertTitle>
          <AlertDescription>
            In a terminal in that folder, switch to a branch that has commits
            (git switch &lt;branch&gt;) or make a first commit, then press
            Create again.
          </AlertDescription>
        </Alert>
      );
    default:
      return <InitOffer check={check} onChanged={onChanged} />;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Where this page would count as on the Bayon host, when it is not opened there already. */
export function localAddress(
  where: Pick<Location, "hostname" | "port" | "protocol"> = window.location,
): string | null {
  const { hostname, port, protocol } = where;
  if (LOOPBACK_HOSTS.has(hostname)) return null;
  return `${protocol}//localhost${port === "" ? "" : `:${port}`}`;
}

function AllowElsewhere({ command }: { readonly command: string }) {
  const local = localAddress();
  return (
    <Alert status="warning" role="status">
      <AlertTitle>Agents are not allowed to use this folder yet.</AlertTitle>
      <AlertDescription>
        <p>
          Only a browser on the machine Bayon runs on can allow a folder. Run
          this there, in a terminal in the Bayon folder, then press Create
          again:
        </p>
        <CopyCommand
          command={command}
          label="the command that allows this folder"
        />
        {local !== null && (
          <p>
            {`If this browser is on the machine Bayon runs on, open Bayon at ${local} instead: it can allow the folder from there.`}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

const SCOPES: readonly FolderAllowScope[] = ["folder", "parent"];

function AllowHere({
  check,
  realPath,
  onChanged,
}: PanelProps & { readonly realPath: string }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<FolderAllowScope>("folder");
  const allow = useMutation({
    mutationFn: allowFolder,
    onSuccess: (allowed) => {
      setOpen(false);
      notify.success("Folder allowed", `Agents may now use ${allowed.root}.`);
      onChanged();
    },
  });
  const parent = check.parent;
  const granted = scope === "parent" && parent !== null ? parent : realPath;
  return (
    <Alert status="info" role="status">
      <AlertTitle>Agents are not allowed to use this folder yet.</AlertTitle>
      <AlertDescription>
        <p>Bayon only gives agents folders you have allowed.</p>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            allow.reset();
            setOpen(true);
          }}
        >
          Allow agents to use this folder
        </Button>
      </AlertDescription>
      <AlertDialog open={open} onOpenChange={(next: boolean) => setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Allow agents to use this folder?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`Agents working on a project in ${granted} can read every file in it and in the folders inside it, and work on a copy of it. This is written to the audit log. To take it back later, run pnpm frm roots remove ${granted} --yes in a terminal.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {parent !== null && (
            <RadioChoices
              legend="What to allow"
              values={SCOPES}
              labels={{ folder: realPath, parent }}
              hints={{
                folder: "Just this folder.",
                parent:
                  "The folder that holds it, so other folders in there need no allowing.",
              }}
              value={scope}
              onChange={setScope}
            />
          )}
          {allow.isError && (
            <Alert status="error">
              <AlertTitle>Not allowed</AlertTitle>
              <AlertDescription>{refusalMessage(allow.error)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={allow.isPending}
              onClick={() =>
                allow.mutate({ path: check.path, scope, expect_root: granted })
              }
            >
              {allow.isPending ? "Allowing…" : "Allow and create the project"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Alert>
  );
}

const INIT_TITLE: Readonly<Record<string, string>> = {
  not_repo_empty: "This folder is empty and not a git repository yet.",
  not_repo_files: "This folder is not a git repository yet.",
  no_commits: "This git repository has no commits yet.",
};

function initSays(check: FolderCheck): string {
  if (check.state === "no_commits") {
    return `Bayon can make one empty first commit on ${check.branch ?? "its current branch"}. Nothing you have written or staged is committed.`;
  }
  const files =
    check.state === "not_repo_files"
      ? " Your files are not added or changed: agents only see what you commit yourself."
      : "";
  return `Bayon can run git init here and make one empty first commit on main.${files}`;
}

function InitOffer({ check, onChanged }: PanelProps) {
  const init = useMutation({
    mutationFn: initFolder,
    onSuccess: () => {
      notify.success("Git repository ready", check.real_path ?? check.path);
      onChanged();
    },
  });
  return (
    <Alert status="info" role="status">
      <AlertTitle>{INIT_TITLE[check.state] ?? ""}</AlertTitle>
      <AlertDescription>
        <p>{initSays(check)}</p>
        <Button
          type="button"
          size="sm"
          disabled={init.isPending}
          onClick={() => init.mutate(check.path)}
        >
          Initialise this folder as a git repository and create the project
        </Button>
        {init.isError && (
          <p className="text-danger">{refusalMessage(init.error)}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}
