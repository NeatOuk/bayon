import { useQuery } from "@tanstack/react-query";
import { Loading } from "@/components/loading";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { executorsQuery } from "@/executors/executors-api";
import { SettingsSection } from "@/components/settings-section";
import { Muted } from "@/tickets/ticket-sections";

// The two security controls, read-only on Settings → General: kept out of the whitelist
// because this page can be served on the LAN with the operator's bearer added by its proxy. Each
// changes only from a shell, through frm's operator door, where the change is checked and audited.
// That shell is `frm settings set <key> <value> --yes`, named here so the note points at
// a command that exists.

/** admission.require_certified, read-only. `undefined` while GET /settings loads. */
export function CertificationRuleNote({
  requireCertified,
}: {
  readonly requireCertified: boolean | null | undefined;
}) {
  return (
    <SettingsSection
      label="certification rule"
      title="Certification rule"
      description="Read-only here: a security control, changed only from a shell."
    >
      <p className="text-sm">
        When on, a session whose runner has not passed certification on its
        executor does not start. Off, a runner nobody has certified runs
        unattended, so it is a security control and not editable here, for the
        same reason as the trust rule. To change it, run this in a shell, where
        every change is checked and audited:{" "}
        <span className="font-mono">
          frm settings set admission.require_certified 0|1 --yes
        </span>
        {", and "}
        <span className="font-mono">frm settings get</span> reads it back.
      </p>
      {requireCertified === undefined && <Loading label="Loading the rule…" />}
      {requireCertified === null && (
        <p role="alert" className="text-sm text-destructive">
          The setting is missing or not 0 or 1, so admission cannot read its
          settings.
        </p>
      )}
      {requireCertified !== undefined && requireCertified !== null && (
        <p className="text-sm">
          {"Now "}
          <StatusBadge
            entity="certRule"
            state={requireCertified ? "on" : "off"}
          />
        </p>
      )}
    </SettingsSection>
  );
}

/** executors.untrusted_roles, read-only: the host's isolation boundary. */
export function TrustRuleNote() {
  const executors = useQuery(executorsQuery);
  const roles = executors.data?.untrusted_roles;
  return (
    <SettingsSection
      label="trust rule"
      title="Trust rule"
      description="Read-only here: the host's isolation boundary, changed only from a shell."
    >
      <p className="text-sm">
        The roles in{" "}
        <span className="font-mono">executors.untrusted_roles</span> run only on
        an untrusted (container) executor. It is the host&apos;s isolation
        boundary, so it is not editable here: this page can be served on the LAN
        with the operator&apos;s bearer. Change it from a shell with{" "}
        <span className="font-mono">
          frm settings set executors.untrusted_roles &lt;role,…&gt; --yes
        </span>{" "}
        (the whole list; <span className="font-mono">none</span> clears it), or
        add roles to it while registering an executor with{" "}
        <span className="font-mono">
          frm executor add … --untrusted-roles &lt;role,…&gt;
        </span>
        . Adding <span className="font-mono">reviewer</span> makes every review
        depend on the container host.
      </p>
      {executors.isError && (
        <QueryError
          title="The trust rule is unavailable"
          error={executors.error}
          onRetry={() => void executors.refetch()}
        />
      )}
      {roles === null && (
        <p role="alert" className="text-sm text-destructive">
          The setting is missing or not a list of roles, so the trust rule
          cannot be applied.
        </p>
      )}
      {roles?.length === 0 && (
        <Muted>No role needs an untrusted executor.</Muted>
      )}
      {roles !== undefined && roles !== null && roles.length > 0 && (
        <ul aria-label="untrusted roles" className="flex flex-wrap gap-1">
          {roles.map((role) => (
            <li key={role}>
              <Badge variant="outline">{role}</Badge>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
