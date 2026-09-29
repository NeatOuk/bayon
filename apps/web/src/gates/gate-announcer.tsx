import { useState } from "react";
import {
  gateChanges,
  lineSignature,
  type GateLine,
} from "@/gates/gate-announce";

/**
 * A polite live region: when a WS snapshot moves a gate, screen readers hear which
 * one and what it reads as now. The first lines it sees are the baseline, so loading a view is
 * silent; the last announcement stays until the next change replaces it.
 */
export function GateAnnouncer({
  lines,
}: {
  readonly lines: readonly GateLine[];
}) {
  const signature = lineSignature(lines);
  const [seen, setSeen] = useState({ signature, lines, message: "" });
  if (seen.signature !== signature) {
    // Adjusting state to a prop change during render (react.dev "you might not need an effect").
    const change = gateChanges(seen.lines, lines);
    setSeen({
      signature,
      lines,
      message: change === "" ? seen.message : change,
    });
  }
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {seen.message}
    </p>
  );
}
