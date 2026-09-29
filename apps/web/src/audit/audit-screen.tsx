import { AuditQuery, type AuditEntryView } from "@bayon/proto";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { z } from "zod";
import { auditQuery, type AuditFilters } from "@/audit/audit-api";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTime } from "@/lib/format";

const NO_FILTER: AuditFilters = { actor: "", action: "" };
/** The filters' own schema, the one GET /audit parses. */
const Filters = AuditQuery.pick({ actor: true, action: true });
/** Past this, a payload is cut in the table; the full text is its title. */
const PAYLOAD_SHOWN = 160;

/** Audit (M4 §12.1): audit_log newest first, filtered, a page at a time. Read-only. */
export function AuditScreen() {
  const [draft, setDraft] = useState<AuditFilters>(NO_FILTER);
  const [filters, setFilters] = useState<AuditFilters>(NO_FILTER);
  const [formError, setFormError] = useState<string | null>(null);
  const actorId = useId();
  const actionId = useId();
  const audit = useInfiniteQuery(auditQuery(filters));
  const items = audit.data?.pages.flatMap((page) => page.items) ?? [];

  function apply(event: FormEvent) {
    event.preventDefault();
    const next = { actor: draft.actor.trim(), action: draft.action.trim() };
    const parsed = Filters.safeParse({
      actor: next.actor === "" ? undefined : next.actor,
      action: next.action === "" ? undefined : next.action,
    });
    if (!parsed.success) {
      setFormError(z.prettifyError(parsed.error));
      return;
    }
    setFormError(null);
    setFilters(next);
  }

  return (
    <PageContainer fill>
      <PageHeader title="Audit" />
      <p className="text-sm text-muted-foreground">
        Every write through the API, and the supervisor&apos;s named writes,
        newest first. A filter is exact, or a prefix when it ends in *:
        session:* or mcp.*.
      </p>
      <form
        aria-label="audit filters"
        onSubmit={apply}
        noValidate
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor={actorId}>Actor</Label>
          <Input
            id={actorId}
            placeholder="operator, supervisor, session:*"
            value={draft.actor}
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={actionId}>Action</Label>
          <Input
            id={actionId}
            placeholder="fleet.*, settings.put"
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
          />
        </div>
        <Button type="submit">Filter</Button>
      </form>
      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}
      {audit.isPending && <Loading label="Loading the audit log…" lines={3} />}
      {audit.isError && (
        <QueryError
          title="The audit log is unavailable"
          error={audit.error}
          onRetry={() => void audit.refetch()}
        />
      )}
      {audit.isSuccess &&
        (items.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No audit rows</EmptyTitle>
              <EmptyDescription>
                Nothing matches these filters yet.
              </EmptyDescription>
            </EmptyHeader>
            {(filters.actor !== "" || filters.action !== "") && (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(NO_FILTER);
                    setFilters(NO_FILTER);
                  }}
                >
                  Clear the filters
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <AuditTable items={items} />
        ))}
      {audit.hasNextPage && (
        <Button
          variant="outline"
          className="self-start"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          {audit.isFetchingNextPage ? "Loading…" : "Load older"}
        </Button>
      )}
    </PageContainer>
  );
}

const dash = (text: string | null): string => text ?? "—";

function payloadText(payload: AuditEntryView["payload"]): string {
  return payload === null ? "—" : JSON.stringify(payload);
}

function AuditTable({ items }: { readonly items: readonly AuditEntryView[] }) {
  return (
    <Table aria-label="audit log" scroll="fill">
      <TableHeader>
        <TableRow>
          <TableHead>when (UTC)</TableHead>
          <TableHead>actor</TableHead>
          <TableHead>action</TableHead>
          <TableHead>target</TableHead>
          <TableHead>details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const full = payloadText(item.payload);
          return (
            <TableRow key={item.id} aria-label={`audit ${item.id}`}>
              <TableCell>{formatTime(item.ts)}</TableCell>
              <TableCell className="font-mono">{item.actor}</TableCell>
              <TableCell className="font-mono">{item.action}</TableCell>
              <TableCell className="font-mono">
                {item.target_kind === null
                  ? dash(item.target_id)
                  : `${item.target_kind}:${dash(item.target_id)}`}
              </TableCell>
              <TableCell className="max-w-96 truncate font-mono" title={full}>
                {full.length > PAYLOAD_SHOWN
                  ? `${full.slice(0, PAYLOAD_SHOWN)}…`
                  : full}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
