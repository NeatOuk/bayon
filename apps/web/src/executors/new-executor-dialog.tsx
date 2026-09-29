import type { CreateExecutorRequest } from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Field } from "@/components/field";
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
import { notify } from "@/components/ui/toast";
import { createExecutor, EXECUTORS_KEY } from "@/executors/executors-api";

interface Form {
  readonly id: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly identityRef: string;
  readonly remoteRoot: string;
  readonly network: string;
  readonly egressAllow: string;
  readonly baseImage: string;
  readonly slots: string;
  readonly minFreePct: string;
  readonly quotaGb: string;
}

const BLANK: Form = {
  id: "",
  host: "",
  port: "",
  user: "",
  identityRef: "",
  remoteRoot: "",
  network: "",
  egressAllow: "",
  baseImage: "",
  slots: "2",
  minFreePct: "",
  quotaGb: "",
};

/** A blank optional field is left out, so the server's own default applies. */
const optional = (value: string): string | undefined =>
  value.trim() === "" ? undefined : value.trim();
const optionalInt = (value: string): number | undefined => {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : Number(trimmed);
};

/** The POST body from the form, or null while a required field is blank. */
function requestOf(form: Form): CreateExecutorRequest | null {
  const id = form.id.trim();
  const host = form.host.trim();
  const user = form.user.trim();
  const identityRef = form.identityRef.trim();
  const remoteRoot = form.remoteRoot.trim();
  if (
    id === "" ||
    host === "" ||
    user === "" ||
    identityRef === "" ||
    remoteRoot === ""
  ) {
    return null;
  }
  return {
    id,
    host,
    port: optionalInt(form.port),
    user,
    identity_ref: identityRef,
    remote_root: remoteRoot,
    slots: Number(form.slots.trim() === "" ? BLANK.slots : form.slots),
    network: optional(form.network),
    egress_allow: form.egressAllow
      .split(",")
      .map((h) => h.trim())
      .filter((h) => h !== ""),
    base_image: optional(form.baseImage),
    min_free_pct: optionalInt(form.minFreePct),
    quota_gb: optionalInt(form.quotaGb),
  };
}

/**
 * The Add executor dialog (§9.5 amendment): registers a container executor, exactly
 * what `frm executor add` writes. The SSH notice is shown unconditionally, not just after a
 * refusal — `POST /executors` never scans a new host's key, only reads the operator's own
 * ~/.ssh/known_hosts, and refuses if the host is not pinned there yet.
 */
export function NewExecutorDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const create = useMutation({
    mutationFn: createExecutor,
    onSuccess: (_created, request) => {
      setOpen(false);
      notify.success(
        "Executor added",
        `${request.id} is registered. Check its health before it takes work.`,
      );
      void queryClient.invalidateQueries({ queryKey: EXECUTORS_KEY });
    },
  });

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setForm(BLANK);
      create.reset();
    }
  }

  const set = (patch: Partial<Form>) =>
    setForm((current) => ({ ...current, ...patch }));

  const request = requestOf(form);
  const error = create.error?.message ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm">Add executor</Button>} />
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Add executor</DialogTitle>
          <DialogDescription>
            Registers a container executor (trust untrusted, egress allowlist).
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Before adding a host, trust its SSH key first: connect once with{" "}
          <code>
            ssh {form.user || "<user>"}@{form.host || "<host>"}
          </code>{" "}
          (or run <code>ssh-copy-id</code>) and accept its fingerprint. Bayon
          checks your <code>~/.ssh/known_hosts</code>; it will never scan a new
          host itself.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Executor id">
            {({ id }) => (
              <Input
                id={id}
                value={form.id}
                onChange={(event) => set({ id: event.target.value })}
              />
            )}
          </Field>
          <Field label="Host">
            {({ id }) => (
              <Input
                id={id}
                value={form.host}
                onChange={(event) => set({ host: event.target.value })}
              />
            )}
          </Field>
          <Field label="Port (default 22)">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                value={form.port}
                onChange={(event) => set({ port: event.target.value })}
              />
            )}
          </Field>
          <Field label="User">
            {({ id }) => (
              <Input
                id={id}
                value={form.user}
                onChange={(event) => set({ user: event.target.value })}
              />
            )}
          </Field>
          <Field
            label="Identity (file:<key path> or agent:<public key path>)"
            className="sm:col-span-2"
          >
            {({ id }) => (
              <Input
                id={id}
                placeholder="file:/path/to/private_key"
                value={form.identityRef}
                onChange={(event) => set({ identityRef: event.target.value })}
              />
            )}
          </Field>
          <Field label="Remote root" className="sm:col-span-2">
            {({ id }) => (
              <Input
                id={id}
                placeholder="/home/ops/frm"
                value={form.remoteRoot}
                onChange={(event) => set({ remoteRoot: event.target.value })}
              />
            )}
          </Field>
          <Field label="Network (default frm-internal)">
            {({ id }) => (
              <Input
                id={id}
                value={form.network}
                onChange={(event) => set({ network: event.target.value })}
              />
            )}
          </Field>
          <Field label="Slots">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                value={form.slots}
                onChange={(event) => set({ slots: event.target.value })}
              />
            )}
          </Field>
          <Field
            label="Egress allowlist (comma-separated hosts)"
            className="sm:col-span-2"
          >
            {({ id }) => (
              <Input
                id={id}
                value={form.egressAllow}
                onChange={(event) => set({ egressAllow: event.target.value })}
              />
            )}
          </Field>
          <Field label="Base image">
            {({ id }) => (
              <Input
                id={id}
                placeholder="node:22-bookworm-slim"
                value={form.baseImage}
                onChange={(event) => set({ baseImage: event.target.value })}
              />
            )}
          </Field>
          <Field label="Min free disk %">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                value={form.minFreePct}
                onChange={(event) => set({ minFreePct: event.target.value })}
              />
            )}
          </Field>
          <Field label="Quota (GB)">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                value={form.quotaGb}
                onChange={(event) => set({ quotaGb: event.target.value })}
              />
            )}
          </Field>
        </div>
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
