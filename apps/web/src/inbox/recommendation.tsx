import { Lightbulb } from "lucide-react";
import { Markdown } from "@/markdown/markdown";

// A human_ask's recommendation, called out the same way wherever the question is read —
// the Inbox's card and its Answer dialog: the info tone's soft box, "Recommendation:" and the
// asker's words, as the API stored them ("Recommendation: …").

export function Recommendation({ text }: { readonly text: string }) {
  return (
    <div
      data-slot="recommendation"
      className="flex items-start gap-2 rounded-lg border border-info/30 bg-info-subtle px-3 py-2 text-sm"
    >
      <Lightbulb
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-info"
      />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1">
        <span className="font-medium">Recommendation: </span>
        <Markdown markdown={text} />
      </div>
    </div>
  );
}
