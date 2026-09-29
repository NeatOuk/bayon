import type { RunnerCaps } from "@bayon/core";
import type {
  CertificationView,
  ExecutorView,
  RunnerUpdateView,
  RunnerView,
} from "@bayon/proto";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fleetQuery } from "@/api/queries";
import { Id } from "@/components/id";
import { SectionTitle } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { TextLink } from "@/components/text-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTime } from "@/lib/format";
import { ConformanceBadges } from "@/runners/conformance-badges";
import { ModelsSection } from "@/runners/models-section";
import { RUNNERS_KEY, dismissRunnerUpdate } from "@/runners/runners-api";
import { RunConformance } from "@/runners/run-conformance";
import { Panel } from "@/tickets/panel";
import { Muted } from "@/tickets/ticket-sections";

/**
 * One `runners` row (§5.1, §15) as the supervisor registered and certified it: version, the
 * capabilities it declares, and its certification per (executor, model) with the per-test results
 * (a certificate holds for the model it was earned on alone).
 */
export function RunnerCard({
  runner,
  executors,
}: {
  readonly runner: RunnerView;
  readonly executors: readonly ExecutorView[];
}) {
  return (
    <Panel label={runner.id} title={runner.id}>
      <RunnerFacts runner={runner} />
      {runner.update !== null && <RunnerUpdateBanner update={runner.update} />}
      <CapsList caps={runner.caps} />
      <Certifications certifications={runner.certifications} />
      <ModelsSection runner={runner} />
      <RunConformance
        runnerId={runner.id}
        executors={executors}
        certifications={runner.certifications}
        models={runner.models}
      />
    </Panel>
  );
}

/**
 * An open runner update check: current → latest, its release notes when the adapter
 * names them, and a Dismiss that clears it (a repeat is idempotent). Nothing here upgrades anything.
 */
function RunnerUpdateBanner({ update }: { readonly update: RunnerUpdateView }) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: () => dismissRunnerUpdate(update.runner_id, update.latest),
    onSuccess: () => {
      // Needs You reads the same open update from the fleet query, not this screen's RUNNERS_KEY:
      // both must drop the item, or one screen keeps showing what the other cleared.
      queryClient.invalidateQueries({ queryKey: RUNNERS_KEY });
      queryClient.invalidateQueries({ queryKey: fleetQuery.queryKey });
    },
  });
  return (
    <div
      role="group"
      aria-label="update available"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
    >
      <Badge variant="warning">Update available</Badge>
      <span>{`${update.current} → ${update.latest}`}</span>
      {update.notes_url !== null && (
        <TextLink href={update.notes_url} className="text-sm">
          Release notes
        </TextLink>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={dismiss.isPending}
        onClick={() => dismiss.mutate()}
        aria-label={`Dismiss the ${update.runner_id} ${update.latest} update`}
      >
        Dismiss
      </Button>
      {dismiss.error !== null && (
        <p role="alert" className="text-sm text-danger">
          {`Not dismissed: ${dismiss.error.message}`}
        </p>
      )}
    </div>
  );
}

function RunnerFacts({ runner }: { readonly runner: RunnerView }) {
  const certified = runner.conformance_passed_at !== null;
  return (
    <div
      role="group"
      aria-label="runner status"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <StatusBadge
        entity="certification"
        state={certified ? "certified" : "uncertified"}
      />
      <StatusBadge
        entity="eligibility"
        state={runner.gate_eligible ? "eligible" : "ineligible"}
      />
      {!runner.enabled && <StatusBadge entity="enabled" state="disabled" />}
      <span>{`${runner.kind} · ${runner.adapter}`}</span>
      <span>{`version ${runner.version_detected ?? "not detected"}`}</span>
      {runner.conformance_passed_at !== null && (
        <span className="text-xs text-muted-foreground">
          {`unattended allowed since ${formatTime(runner.conformance_passed_at)} UTC`}
        </span>
      )}
    </div>
  );
}

function CapsList({ caps }: { readonly caps: RunnerCaps | null }) {
  if (caps === null)
    return (
      <Muted>
        Its capabilities (caps_json) do not parse: none are assumed.
      </Muted>
    );
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle as="h3">Declared capabilities</SectionTitle>
      <ul aria-label="capabilities" className="flex flex-wrap gap-1">
        {Object.entries(caps).map(([cap, on]) => {
          const state = on ? "yes" : "no";
          return (
            <li key={cap}>
              <StatusBadge
                entity="capability"
                state={state}
                label={`${cap}: ${state}`}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Certifications({
  certifications,
}: {
  readonly certifications: readonly CertificationView[];
}) {
  if (certifications.length === 0)
    return (
      <Muted>
        No conformance run on any executor or model yet: uncertified everywhere.
      </Muted>
    );
  return (
    <Table aria-label="certifications">
      <TableHeader>
        <TableRow>
          <TableHead>executor</TableHead>
          <TableHead>model</TableHead>
          <TableHead>status</TableHead>
          <TableHead>versions</TableHead>
          <TableHead>run</TableHead>
          <TableHead>tests</TableHead>
          <TableHead>report</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {certifications.map((c) => (
          <CertificationRow
            key={`${c.executor_id}\u0000${c.model_id}\u0000${String(c.compression)}`}
            certification={c}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function CertificationStatus({ c }: { readonly c: CertificationView }) {
  if (c.decertified_at !== null)
    return (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge entity="certification" state="decertified" />
        <span className="text-xs">
          {`${formatTime(c.decertified_at)} UTC: ${c.decertified_reason ?? "no reason recorded"}`}
        </span>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge
        entity="certification"
        state={c.passed_at === null ? "not certified" : "certified"}
      />
      {c.gate_eligible && <StatusBadge entity="eligibility" state="eligible" />}
    </div>
  );
}

function CertificationRow({
  certification: c,
}: {
  readonly certification: CertificationView;
}) {
  return (
    <TableRow>
      <TableCell>
        <Id value={c.executor_id} />
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="font-mono text-xs">{c.model}</span>
        <span className="block text-xs text-muted-foreground">
          {c.model_id}
        </span>
        {c.compression && (
          <span className="block text-xs text-muted-foreground">
            with context compression
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-normal">
        <CertificationStatus c={c} />
      </TableCell>
      <TableCell>{`runner ${c.runner_version} · suite ${c.suite_version}`}</TableCell>
      <TableCell>{`${formatTime(c.certified_at)} UTC`}</TableCell>
      <TableCell className="whitespace-normal">
        {c.summary === null ? (
          <Muted>The stored result does not parse.</Muted>
        ) : (
          <ConformanceBadges summary={c.summary} />
        )}
      </TableCell>
      <TableCell className="font-mono text-xs break-all whitespace-normal">
        {c.report_path ?? "—"}
      </TableCell>
    </TableRow>
  );
}
