import { StatusBadge, StatusIcon } from "@/components/status-badge";
import { useFeedStatus } from "@/feed/feed";

/**
 * The top bar's feed light. Silent while the feed delivers — an always-on "live" badge
 * is noise — and loud the moment it stops, because every live list goes quietly empty when it does.
 * Below `sm` the icon alone shows (one row at 320px); the words stay for assistive tech.
 */
export function FeedIndicator() {
  const status = useFeedStatus();
  if (status === "open") return null;
  return (
    <span role="status" className="flex shrink-0 items-center">
      <StatusIcon entity="feed" state={status} className="sm:hidden" />
      <span className="max-sm:sr-only">
        <StatusBadge entity="feed" state={status} />
      </span>
    </span>
  );
}
