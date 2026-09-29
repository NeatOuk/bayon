import { BindingRole } from "@bayon/core";
import type {
  CertificationView,
  RoleBindingView,
  RunnerView,
} from "@bayon/proto";
import { useQuery } from "@tanstack/react-query";
import { Id } from "@/components/id";
import { Loading } from "@/components/loading";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { executorsQuery } from "@/executors/executors-api";
import { formatTime } from "@/lib/format";
import { runnersQuery } from "@/runners/runners-api";
import { RoleBindingDialog } from "@/settings/role-binding-dialog";
import { roleBindingsQuery } from "@/settings/roles-api";

/**
 * Settings → Roles (§9.8, §12.3): who works each role, the model it runs (its tier, else its
 * profile's) and whether that exact (runner, executor, model) is certified.
 */
export function RolesScreen() {
  const bindings = useQuery(roleBindingsQuery);
  const runners = useQuery(runnersQuery);
  const executors = useQuery(executorsQuery);
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings · Roles" />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Each role is a binding to a runner row, and runs one of its models: the
        binding's tier, else its profile's. Certification is per model: a review
        needs the model it runs certified and gate-eligible on its executor.
        That is checked when a gate runs, so an uncertified binding is flagged
        here, not refused.
      </p>
      {bindings.isPending && (
        <Loading label="Loading the role bindings…" lines={4} />
      )}
      {bindings.isError && (
        <QueryError
          title="The role bindings are unavailable"
          error={bindings.error}
          onRetry={() => void bindings.refetch()}
        />
      )}
      {runners.isError && (
        <QueryError
          title="The runners are unavailable"
          error={runners.error}
          onRetry={() => void runners.refetch()}
        />
      )}
      {executors.isError && (
        <QueryError
          title="The executors are unavailable"
          error={executors.error}
          onRetry={() => void executors.refetch()}
        />
      )}
      {bindings.data !== undefined && (
        <RolesTable
          bindings={bindings.data.items}
          runners={runners.data?.runners}
          executors={(executors.data?.executors ?? []).map((e) => e.id)}
        />
      )}
    </div>
  );
}

const dash = (text: string | null | undefined): string => text ?? "—";

/** A runner or executor id, or a dash when the binding leaves it to its default. */
const IdOrDash = ({ value }: { readonly value: string | null | undefined }) =>
  value === null || value === undefined ? "—" : <Id value={value} />;

function RolesTable({
  bindings,
  runners,
  executors,
}: {
  readonly bindings: readonly RoleBindingView[];
  /** Undefined while they load: no certification badge until then. */
  readonly runners: readonly RunnerView[] | undefined;
  /** The executor ids a binding may name (GET /executors). */
  readonly executors: readonly string[];
}) {
  const runnerIds = (runners ?? []).map((runner) => runner.id);
  return (
    <Table aria-label="role bindings">
      <TableHeader>
        <TableRow>
          <TableHead>role</TableHead>
          <TableHead>runner</TableHead>
          <TableHead>model tier</TableHead>
          <TableHead>model</TableHead>
          <TableHead>executor</TableHead>
          <TableHead>profile</TableHead>
          <TableHead>fallback</TableHead>
          <TableHead>must differ from</TableHead>
          <TableHead>updated</TableHead>
          <TableHead>
            <span className="sr-only">actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {BindingRole.options.map((role) => {
          const binding = bindings.find((b) => b.role === role);
          return (
            <TableRow key={role} aria-label={role}>
              <TableCell className="font-head">{role}</TableCell>
              <TableCell>
                {binding === undefined ? (
                  <span className="text-muted-foreground">unbound</span>
                ) : (
                  <RunnerCell binding={binding} runners={runners} />
                )}
              </TableCell>
              <TableCell>{dash(binding?.model_tier)}</TableCell>
              <TableCell>
                {binding?.model == null ? (
                  <span className="text-muted-foreground">
                    {binding === undefined ? "—" : "each agent's profile"}
                  </span>
                ) : (
                  <span className="font-mono text-xs">{binding.model}</span>
                )}
              </TableCell>
              <TableCell>
                <IdOrDash value={binding?.executor_id} />
              </TableCell>
              <TableCell>{dash(binding?.profile_id)}</TableCell>
              <TableCell>
                <IdOrDash value={binding?.fallback_runner_id} />
              </TableCell>
              <TableCell>{dash(binding?.require_distinct_from)}</TableCell>
              <TableCell>
                {binding === undefined
                  ? "—"
                  : `${formatTime(binding.updated_at)} UTC${binding.updated_by === null ? "" : ` by ${binding.updated_by}`}`}
              </TableCell>
              <TableCell>
                <RoleBindingDialog
                  role={role}
                  binding={binding}
                  runners={runnerIds}
                  executors={executors}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * The live certificate of the binding's own triple: its runner, its model, and its
 * executor — any executor when the binding names none, since a gate then runs where its subject
 * was built. Undefined: none; the binding's model unknown (each agent's profile decides) is too.
 */
export function bindingCertificate(
  binding: RoleBindingView,
  runner: RunnerView,
): CertificationView | undefined {
  if (binding.model_id === null) return undefined;
  // The normal certificate: a compression-on one admits only a project that compresses.
  return runner.certifications.find(
    (c) =>
      !c.compression &&
      c.model_id === binding.model_id &&
      (binding.executor_id === null || c.executor_id === binding.executor_id) &&
      c.passed_at !== null &&
      c.decertified_at === null,
  );
}

function RunnerCell({
  binding,
  runners,
}: {
  readonly binding: RoleBindingView;
  readonly runners: readonly RunnerView[] | undefined;
}) {
  const runner = runners?.find((r) => r.id === binding.runner_id);
  const cert =
    runner === undefined ? undefined : bindingCertificate(binding, runner);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Id value={binding.runner_id} />
      {runners !== undefined && runner === undefined && (
        <StatusBadge entity="runnerRef" state="unknown" />
      )}
      {runner !== undefined && (
        <StatusBadge
          entity="certification"
          state={cert === undefined ? "uncertified" : "certified"}
        />
      )}
      {runner !== undefined && cert !== undefined && !cert.gate_eligible && (
        <StatusBadge entity="eligibility" state="ineligible" />
      )}
    </div>
  );
}
