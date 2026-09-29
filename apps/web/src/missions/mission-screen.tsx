import { renderMission, sectionKey, type MissionSection } from "@bayon/core";
import type { MissionSaveRequest, MissionView } from "@bayon/proto";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useId, useState, type ReactNode } from "react";
import { ApiRequestError } from "@/api/http";
import { missionQuery, saveMission } from "@/api/queries";
import { AgentBackLink } from "@/app-shell/back-link";
import { Loading } from "@/components/loading";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toast";
import { MissionConflict } from "@/missions/mission-conflict";
import {
  SECTION_FIELDS,
  saveRequest,
  textOf,
  versionOf,
  withSection,
  type SectionField,
} from "@/missions/mission-draft";
import { Markdown } from "@/markdown/markdown";
import { MissionHistory } from "@/missions/mission-history";

const isStaleBase = (error: Error): boolean =>
  error instanceof ApiRequestError && error.status === 409;

/** The page's own frame, or none inside another view (the orchestrator's). */
function Frame({
  embedded,
  children,
}: {
  readonly embedded: boolean;
  readonly children: ReactNode;
}) {
  return embedded ? (
    <div className="flex flex-col gap-4">{children}</div>
  ) : (
    <PageContainer>{children}</PageContainer>
  );
}

/**
 * §12.3 mission editor: `#/missions/:agent`, `section` focused when opened to add a law. The way
 * back returns to where the operator came from, else to the agent's tab in its project.
 * `embedded` drops the page chrome — the way back and the page's heading — for a view that holds
 * the editor in a section of its own (the IDE's Orchestrator view).
 */
export function MissionScreen({
  agent,
  section,
  embedded = false,
}: {
  readonly agent: string;
  readonly section?: MissionSection | undefined;
  readonly embedded?: boolean;
}) {
  const mission = useQuery(missionQuery(agent));
  const latest = mission.data?.latest;
  const version =
    latest === undefined ? null : (
      <Badge variant="outline">
        {latest === null ? "no mission yet" : `v${latest.version}`}
      </Badge>
    );
  return (
    <Frame embedded={embedded}>
      {!embedded && <AgentBackLink agent={agent} />}
      {embedded ? (
        version !== null && <div>{version}</div>
      ) : (
        <PageHeader title={`Mission · ${agent}`} meta={version ?? undefined} />
      )}
      {mission.isPending && <Loading label="Loading the mission…" />}
      {mission.isError && (
        <QueryError
          title="The mission is unavailable"
          error={mission.error}
          onRetry={() => void mission.refetch()}
        />
      )}
      {mission.data !== undefined && (
        <MissionEditor
          agent={agent}
          view={mission.data}
          focus={section}
          // Embedded, the mission sits in its host's h2 section; on its own page, under the h1.
          headingLevel={embedded ? 3 : 2}
        />
      )}
    </Frame>
  );
}

function MissionEditor({
  agent,
  view,
  focus,
  headingLevel,
}: {
  readonly agent: string;
  readonly view: MissionView;
  readonly focus: MissionSection | undefined;
  readonly headingLevel: 2 | 3;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => textOf(view.latest));
  const [base, setBase] = useState(() => versionOf(view.latest));
  const [note, setNote] = useState("");
  const noteId = useId();
  const hintId = useId();
  const refetch = () =>
    queryClient.invalidateQueries({ queryKey: missionQuery(agent).queryKey });

  const save = useMutation({
    mutationFn: (request: MissionSaveRequest) => saveMission(agent, request),
    onSuccess: (saved) => {
      setBase(saved.version);
      setNote("");
      notify.success(`Saved v${saved.version}`, `The mission of ${agent}.`);
      void refetch();
    },
    // A stale base: fetch the version that won, so the conflict panel can show it.
    onError: (error) => {
      if (isStaleBase(error)) void refetch();
    },
  });

  const newer =
    view.latest !== null && view.latest.version > base ? view.latest : null;
  const request = saveRequest(text, note, base);
  const settle = (nextBase: number) => {
    setBase(nextBase);
    save.reset();
  };

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          {SECTION_FIELDS.map((field) => (
            <SectionEditor
              key={field.section}
              field={field}
              value={text[sectionKey(field.section)]}
              focused={focus === field.section}
              onChange={(md) =>
                setText((t) => withSection(t, field.section, md))
              }
            />
          ))}
        </div>
        <Tabs defaultValue="preview">
          <TabsList>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          <TabsContent value="preview">
            <section
              aria-label="Preview"
              className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm"
            >
              <Markdown markdown={renderMission(agent, text)} />
            </section>
          </TabsContent>
          <TabsContent value="history">
            <MissionHistory
              agent={agent}
              versions={view.versions}
              headingLevel={headingLevel}
            />
          </TabsContent>
        </Tabs>
      </div>
      {newer !== null && (
        <MissionConflict
          base={base}
          latest={newer}
          onKeep={() => settle(newer.version)}
          onLoad={() => {
            setText(textOf(newer));
            settle(newer.version);
          }}
        />
      )}
      <footer className="flex flex-wrap items-end gap-3 border-t pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Label htmlFor={noteId}>Changelog</Label>
          <Input
            id={noteId}
            value={note}
            placeholder="What changed, and why"
            aria-describedby={hintId}
            // Locked in flight: a successful save clears the line, which would drop a late edit.
            disabled={save.isPending}
            onChange={(event) => setNote(event.target.value)}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {request === null
              ? "A new version needs a changelog line."
              : `Saves as v${base + 1}.`}
          </p>
        </div>
        <Button
          disabled={request === null || newer !== null || save.isPending}
          onClick={() => request !== null && save.mutate(request)}
        >
          Save
        </Button>
      </footer>
      <SaveStatus error={save.error} waitingForNewer={newer === null} />
    </>
  );
}

/**
 * The last save's failure; a save that lands is a toast. A 409 is not an alert of its own: the
 * conflict panel is, once the refetch brings the newer version (until then, `waitingForNewer`).
 */
function SaveStatus({
  error,
  waitingForNewer,
}: {
  readonly error: Error | null;
  readonly waitingForNewer: boolean;
}) {
  if (error === null) return null;
  if (!isStaleBase(error))
    return (
      <p role="alert" className="text-sm text-destructive">
        {error.message}
      </p>
    );
  return waitingForNewer ? (
    <p role="status" className="text-sm">
      Your draft is behind the saved mission; loading the newer version…
    </p>
  ) : null;
}

function SectionEditor({
  field,
  value,
  focused,
  onChange,
}: {
  readonly field: SectionField;
  readonly value: string;
  readonly focused: boolean;
  readonly onChange: (md: string) => void;
}) {
  const id = useId();
  const hintId = useId();
  // Opened to add a law: focus the section with the caret at its end, ready for a new line.
  const focusAtEnd = useCallback((el: HTMLTextAreaElement | null) => {
    if (el === null) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{field.label}</Label>
      <p id={hintId} className="text-xs text-muted-foreground">
        {field.hint}
      </p>
      <Textarea
        id={id}
        ref={focused ? focusAtEnd : undefined}
        aria-describedby={hintId}
        className="min-h-24 font-mono"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
