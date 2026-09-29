// §15 #13 structured review output, gated on `outputSchema`: with the cap the suite reads ONLY
// SendSpec.output.path (never the reply text, which would certify an unwired cap) and parses it
// strictly; without it the heuristic parser must find the planted bug in the reply.
import { join } from "node:path";
import { REVIEW_OUTPUT_JSON_SCHEMA, parseReviewOutput } from "@bayon/core";
import { check, define } from "./define.js";

export interface ReviewEvidence {
  readonly source: "output_file" | "assistant_text";
  readonly text: string | undefined;
}

const OUTPUT_FILE = "review.json";

function findings(text: string, outputSchema: boolean) {
  const parsed = parseReviewOutput(text, outputSchema);
  const onAdd =
    parsed.ok &&
    parsed.value.findings.some((f) => (f.file ?? "").endsWith("add.js"));
  return {
    parse: parsed.ok ? parsed.value.parse : undefined,
    onAdd,
    detail: parsed.ok
      ? `${parsed.value.findings.length} findings (${parsed.value.parse})`
      : parsed.error.message,
  };
}

export function judgeReview(e: ReviewEvidence) {
  if (e.source === "output_file") {
    if (e.text === undefined) {
      return [
        check("output_file", false, "SendSpec.output.path was never written"),
      ];
    }
    const f = findings(e.text, true);
    return [
      check("output_file", true),
      check("schema_findings", f.parse === "schema" && f.onAdd, f.detail),
    ];
  }
  const seen = check("review_text_seen", e.text !== undefined, null, {
    precondition: true,
  });
  if (e.text === undefined) return [seen];
  const f = findings(e.text, false);
  return [
    seen,
    check("heuristic_findings", f.parse === "heuristic" && f.onAdd, f.detail),
  ];
}

export const t13 = define({
  id: 13,
  retries: 1,
  fallback: () =>
    "outputSchema=false; the heuristic parser found the planted bug in add.js",
  drive: async (ctx, branch): Promise<ReviewEvidence> => {
    // The schema is in the spawn spec too, as a gate's reviewer spawns with its run 1: a runner
    // that fixes it when its process starts reads it there, one that takes it per turn ignores it.
    const schema = { schema: REVIEW_OUTPUT_JSON_SCHEMA };
    const live = await ctx.open({
      scenario: "review",
      ...(branch === "cap" ? { output: schema } : {}),
    });
    await live.spawn();
    if (branch === "cap") {
      const path = join(live.dirs.tmpDir, OUTPUT_FILE);
      await live.run(live.turn(0), { output: { ...schema, path } });
      return {
        source: "output_file",
        text: await ctx.harness("workspace", ctx.ports.workspace.read(path)),
      };
    }
    const end = await live.run(live.turn(0));
    const replies = end.events.flatMap((e) =>
      e.kind === "assistant_text" ? [e.text] : [],
    );
    return { source: "assistant_text", text: replies.at(-1) };
  },
  judge: judgeReview,
});
