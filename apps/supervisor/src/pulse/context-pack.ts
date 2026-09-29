// The context pack builder (§10.1): a pulse's pack from one snapshot of the database and the
// pulse's probe checks, compiled through the pulse template at the budget run 1 gets (the pulse
// run class's cap less the pre-flight margin, as compileRun fits it) and written to
// runtime/pulses/<id>/context.md. The same state and checks give the same bytes, and startRun's
// compile of the returned inputs gives exactly the file's text. The scheduler takes
// the inputs through the ContextPackBuilder port, or the whole pack from buildContextPack to
// record pulses.context_pack_path and context_tokens.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TEMPLATES,
  compile,
  err,
  localTokens,
  ok,
  promptBudget,
  sha256Hex,
  type CompiledPrompt,
  type PromptInputs,
  type Result,
  type Truncation,
} from "@bayon/core";
import {
  getContextPackInputs,
  listRunClasses,
  type ContextPackInputs,
  type Db,
  type PulseCheckRow,
} from "@bayon/db";
import { z } from "zod";
import { frmError } from "../lifecycle/errors.js";
import { loadSettings } from "../lifecycle/settings.js";
import { packSections, probeBlocks } from "./context-pack-render.js";

/** The run class a pulse session runs under: its context_tokens_cap is the pack's cap. */
const PULSE_RUN_CLASS = "pulse";

export interface ContextPackRequest {
  readonly agentId: string;
  readonly pulseId: string;
  /** The pulse's probe results, as the scheduler inserted them. */
  readonly checks: readonly PulseCheckRow[];
}

/** port (pulse/ports.ts, design §9): the pulse template's inputs for run 1. */
export interface ContextPackBuilder {
  build(a: ContextPackRequest): Promise<Result<PromptInputs>>;
}

export interface ContextPack {
  /** The pulse template's inputs: what run 1 compiles. */
  readonly inputs: PromptInputs;
  /** `pulses.context_pack_path`. */
  readonly path: string;
  /** `pulses.context_tokens`: the pack in local tokens. */
  readonly tokens: number;
  /** sha256 of the pack's bytes. */
  readonly hash: string;
  /** What the budget cut, in truncation order. */
  readonly truncated: readonly Truncation[];
}

export interface ContextPackDeps {
  readonly db: Db;
  /** $FRM_HOME: the pack goes under runtime/pulses/. */
  readonly frmHome: string;
}

/** A pulse id names a directory: letters, digits, `_` and `-` only. */
const RequestShape = z.object({
  agentId: z.string().min(1),
  pulseId: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
});

export const contextPackPath = (frmHome: string, pulseId: string): string =>
  join(frmHome, "runtime", "pulses", pulseId, "context.md");

/**
 * Builds, compiles and writes the pulse's context pack. A bad id is `validation`; an unknown
 * pulse `not_found`; another agent's pulse `validation`; a missing pulse run class `validation`.
 */
export async function buildContextPack(
  deps: ContextPackDeps,
  a: ContextPackRequest,
): Promise<Result<ContextPack>> {
  const req = RequestShape.safeParse({
    agentId: a.agentId,
    pulseId: a.pulseId,
  });
  if (!req.success) {
    return err(
      frmError(
        "validation",
        `bad context pack request: ${z.prettifyError(req.error)}`,
      ),
    );
  }
  const maxTokens = await packBudget(deps.db);
  if (!maxTokens.ok) return maxTokens;
  const read = await getContextPackInputs(deps.db, req.data);
  if (!read.ok) return read;
  const fitted = fit(read.value, a.checks, maxTokens.value);
  if (!fitted.ok) return fitted;
  const { inputs, compiled } = fitted.value;
  const path = contextPackPath(deps.frmHome, req.data.pulseId);
  const saved = await save(path, compiled.text);
  if (!saved.ok) return saved;
  return ok({
    inputs,
    path,
    tokens: localTokens(compiled.text),
    hash: await sha256Hex(compiled.text),
    truncated: compiled.truncated,
  });
}

/** The port: buildContextPack's inputs. */
export function contextPackBuilder(deps: ContextPackDeps): ContextPackBuilder {
  return {
    async build(a) {
      const pack = await buildContextPack(deps, a);
      return pack.ok ? ok(pack.value.inputs) : pack;
    },
  };
}

/** What compileRun fits run 1 into: the pulse run class's cap less the pre-flight margin. */
async function packBudget(db: Db): Promise<Result<number>> {
  const settings = await loadSettings(db);
  if (!settings.ok) return settings;
  const classes = await listRunClasses(db);
  if (!classes.ok) return classes;
  const pulse = classes.value.find((c) => c.name === PULSE_RUN_CLASS);
  return pulse === undefined
    ? err(frmError("validation", `no run class ${PULSE_RUN_CLASS}`))
    : ok(
        promptBudget(
          pulse.context_tokens_cap,
          settings.value["preflight.margin_pct"],
        ),
      );
}

interface Fitted {
  readonly inputs: PromptInputs;
  readonly compiled: CompiledPrompt;
}

/**
 * Compiles the pack with as many pending hand-offs, then probe blocks, as fit whole. When its cap
 * or the budget would cut the hand-offs section, the oldest hand-off shown goes (and is counted as
 * left out), so no ticket_staff call is ever cut; then, the same way, the last probe block, so no
 * fence is left open. Hand-offs first: the budget cuts probes before them, so dropping probe
 * blocks never makes room for a hand-off, and dropping a hand-off never cuts a probe block.
 */
function fit(
  p: ContextPackInputs,
  checks: readonly PulseCheckRow[],
  maxTokens: number,
): Result<Fitted> {
  const blocks = probeBlocks(checks, p);
  const attempt = (handoffs: number, probes: number): Result<Fitted> => {
    const inputs = packSections(
      p,
      { blocks: blocks.slice(0, probes), omitted: blocks.length - probes },
      handoffs,
    );
    const compiled = compile(TEMPLATES.pulse, inputs, { maxTokens });
    if (!compiled.ok) return compiled;
    const cut = (section: string): boolean =>
      compiled.value.truncated.some((t) => t.section === section);
    if (cut("handoffs") && handoffs > 0) return attempt(handoffs - 1, probes);
    if (cut("probes") && probes > 0) return attempt(handoffs, probes - 1);
    return ok({ inputs, compiled: compiled.value });
  };
  return attempt(p.handoffs.rows.length, blocks.length);
}

async function save(path: string, text: string): Promise<Result<void>> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
    return ok(undefined);
  } catch (e) {
    return err(frmError("internal", `cannot write ${path}`, String(e)));
  }
}
