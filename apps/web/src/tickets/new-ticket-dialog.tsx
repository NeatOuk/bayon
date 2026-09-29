import {
  TicketType,
  type CreateTicketRequest,
  type WorkspaceView,
} from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { createTicket, TICKETS_KEY, workspacesQuery } from "@/api/queries";
import { ChoiceField } from "@/components/choice-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toast";
import { ticketHref } from "@/routing";
import { ProjectSelect } from "@/tickets/project-select";

const PRIORITIES = ["1", "2", "3", "4", "5"] as const;

interface Form {
  readonly title: string;
  readonly type: string;
  readonly body_md: string;
  readonly acceptance_md: string;
  readonly priority: string;
}

const BLANK: Form = {
  title: "",
  type: "feature",
  body_md: "",
  acceptance_md: "",
  priority: "3",
};

/**
 * The project a new ticket starts in: the view's own project when opened from one,
 * else the only project when there is exactly one, else none.
 */
export function defaultProjectOf(
  viewProject: string | null,
  workspaces: readonly WorkspaceView[],
): string | null {
  if (viewProject !== null) return viewProject;
  const [only, ...rest] = workspaces;
  return only !== undefined && rest.length === 0 ? only.id : null;
}

/** The POST body from the form and its project, or null while the title is blank. */
function requestOf(
  form: Form,
  workspaceId: string | null,
): CreateTicketRequest | null {
  const title = form.title.trim();
  if (title === "") return null;
  return {
    title,
    type: TicketType.parse(form.type),
    workspace_id: workspaceId ?? undefined,
    body_md: form.body_md.trim() === "" ? undefined : form.body_md,
    acceptance_md:
      form.acceptance_md.trim() === "" ? undefined : form.acceptance_md,
    priority: Number(form.priority),
  };
}

/**
 * The New ticket dialog (§12.3): title, type, project, body and acceptance
 * (markdown) and priority; `POST /tickets` lands it in backlog. On success, the board's list
 * refetches and the operator lands on the new ticket instead of re-reading it off the board.
 */
export function NewTicketDialog({
  defaultProject = null,
}: {
  /** The board's project filter: a new ticket starts in it. */
  readonly defaultProject?: string | null;
} = {}) {
  const queryClient = useQueryClient();
  const workspaces = useQuery(workspacesQuery);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  // Undefined until the operator picks: the default follows the projects as they load.
  const [pickedProject, setPickedProject] = useState<string | null>();
  const create = useMutation({
    mutationFn: createTicket,
    onSuccess: (view) => {
      setOpen(false);
      notify.success(`Created ${view.key}`, view.title);
      void queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
      window.location.hash = ticketHref(view.num);
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setForm(BLANK);
      setPickedProject(undefined);
      create.reset();
    }
  }

  const set = (patch: Partial<Form>) =>
    setForm((current) => ({ ...current, ...patch }));

  const workspaceId =
    pickedProject !== undefined
      ? pickedProject
      : defaultProjectOf(defaultProject, workspaces.data?.workspaces ?? []);
  const request = requestOf(form, workspaceId);
  const titleId = useId();
  const workspaceLabelId = useId();
  const bodyId = useId();
  const acceptanceId = useId();
  const error = create.error?.message ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm">New ticket</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            Lands in backlog; body and acceptance are markdown.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label htmlFor={titleId}>Title</Label>
          <Input
            id={titleId}
            value={form.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </div>
        <ChoiceField
          label="Type"
          value={form.type}
          options={TicketType.options}
          onChange={(type) => set({ type: type ?? BLANK.type })}
        />
        <div className="flex flex-col gap-1">
          <Label id={workspaceLabelId}>Project</Label>
          <ProjectSelect
            labelId={workspaceLabelId}
            noneLabel="(none)"
            value={workspaceId}
            onChange={setPickedProject}
            className="w-full"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={bodyId}>Body</Label>
          <Textarea
            id={bodyId}
            value={form.body_md}
            onChange={(event) => set({ body_md: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={acceptanceId}>Acceptance</Label>
          <Textarea
            id={acceptanceId}
            value={form.acceptance_md}
            onChange={(event) => set({ acceptance_md: event.target.value })}
          />
        </div>
        <ChoiceField
          label="Priority"
          value={form.priority}
          options={PRIORITIES}
          onChange={(priority) => set({ priority: priority ?? BLANK.priority })}
        />
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={request === null || create.isPending}
            onClick={() => {
              if (request !== null) create.mutate(request);
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
