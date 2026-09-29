import type {
  CertificationView,
  RunnerModelView,
  RunnerView,
} from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ModelDialog } from "@/runners/model-dialog";
import {
  RUNNERS_KEY,
  deactivateModel,
  patchModel,
} from "@/runners/runners-api";
import { Muted } from "@/tickets/ticket-sections";

/** The frm line that changes a model's settings, which the GUI never does (they direct egress). */
export const SETTINGS_COMMAND = "frm config apply <file.json> --yes";

const price = (p: number | null): string => (p === null ? "unpriced" : `$${p}`);

/**
 * The executors a model holds a live certificate on (per model): its normal one, earned
 * with context compression off (the runner card lists the compression-on ones too).
 */
export const certifiedOn = (
  modelId: string,
  certifications: readonly CertificationView[],
): readonly string[] =>
  certifications
    .filter(
      (c) =>
        !c.compression &&
        c.model_id === modelId &&
        c.passed_at !== null &&
        c.decertified_at === null,
    )
    .map((c) => c.executor_id);

function ModelRow({
  runnerId,
  model: m,
  certifications,
  toggle,
  busy,
}: {
  readonly runnerId: string;
  readonly model: RunnerModelView;
  readonly certifications: readonly CertificationView[];
  readonly toggle: (m: RunnerModelView) => void;
  readonly busy: boolean;
}) {
  const on = certifiedOn(m.id, certifications);
  const settings = Object.keys(m.settings).length === 0;
  return (
    <TableRow>
      <TableCell className="whitespace-normal">
        <span className="font-mono text-xs">{m.id}</span>
        <span className="block font-mono text-xs text-muted-foreground">
          {m.model}
        </span>
      </TableCell>
      <TableCell>
        {m.effort === null ? m.tier : `${m.tier} · ${m.effort}`}
      </TableCell>
      <TableCell className="whitespace-normal text-xs">
        {`in ${price(m.price_in_per_mtok)} · out ${price(m.price_out_per_mtok)}`}
        <span className="block text-muted-foreground">
          {`cache ${price(m.price_cache_read_per_mtok)} / ${price(m.price_cache_write_per_mtok)}`}
        </span>
      </TableCell>
      <TableCell>{m.context_tokens ?? "—"}</TableCell>
      <TableCell>{m.source}</TableCell>
      <TableCell>
        <StatusBadge
          entity="enabled"
          state={m.active ? "enabled" : "disabled"}
          label={m.active ? "Active" : "Inactive"}
        />
      </TableCell>
      <TableCell className="whitespace-normal">
        {on.length === 0 ? "—" : on.join(", ")}
      </TableCell>
      <TableCell className="font-mono text-xs break-all whitespace-normal">
        {settings ? "—" : JSON.stringify(m.settings)}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <ModelDialog runnerId={runnerId} editing={m} />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => toggle(m)}
          >
            {m.active ? "Turn off" : "Turn on"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Runners → Models: the runner's models, active and turned off, with who owns each row
 * (its adapter's registration or the operator), its prices, context and the executors it is
 * certified on; add one, edit its tier, effort and prices, or turn it off or on. One active model
 * per tier: the server refuses a second of the operator's, and says so here. Settings (a provider
 * URL) are shown, never edited: `frm config apply … --yes` changes them.
 */
export function ModelsSection({ runner }: { readonly runner: RunnerView }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (m: RunnerModelView) =>
      m.active
        ? deactivateModel(runner.id, m.id)
        : patchModel(runner.id, m.id, { active: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNNERS_KEY }),
  });
  const rows = [...runner.models, ...runner.inactive_models];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle as="h3">Models</SectionTitle>
        <ModelDialog runnerId={runner.id} />
      </div>
      {rows.length === 0 ? (
        <Muted>
          No model: add one, or boot the supervisor to register its own.
        </Muted>
      ) : (
        <Table aria-label="models">
          <TableHeader>
            <TableRow>
              <TableHead>model</TableHead>
              <TableHead>tier</TableHead>
              <TableHead>price / Mtok</TableHead>
              <TableHead>context</TableHead>
              <TableHead>source</TableHead>
              <TableHead>status</TableHead>
              <TableHead>certified on</TableHead>
              <TableHead>settings</TableHead>
              <TableHead>change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <ModelRow
                key={m.id}
                runnerId={runner.id}
                model={m}
                certifications={runner.certifications}
                toggle={(row) => toggle.mutate(row)}
                busy={toggle.isPending}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {toggle.isError && (
        <p role="alert" className="text-sm text-destructive">
          {`Not changed: ${toggle.error.message}`}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {`Settings, such as a provider URL, direct network egress: they are read-only here. Change them with ${SETTINGS_COMMAND}.`}
      </p>
    </div>
  );
}
