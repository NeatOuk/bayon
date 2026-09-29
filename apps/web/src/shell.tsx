import { useEffect, useState } from "react";
import { createQueryClient } from "@/api/query-client";
import { App } from "@/app";
import { createBrowserFeed, type Feed } from "@/feed/feed";

/**
 * The app once the gate opens: its own /ws feed, created and closed inside this one effect.
 * StrictMode double-invokes effects in dev (mount, cleanup, mount again) to catch exactly the bug
 * a feed created via useState's initializer would have: the cleanup would close the one shared
 * instance and the second "mount" would reuse that now-permanently-dead client, for the app's whole
 * life. Owning both the create and the close here means the double-invoke yields a fresh, live feed.
 */
export function Shell({
  onLogout,
}: {
  readonly onLogout: (() => void) | null;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [queryClient] = useState(createQueryClient);
  useEffect(() => {
    const created = createBrowserFeed(window.location);
    setFeed(created);
    return () => created.close();
  }, []);
  if (feed === null) return null;
  return <App feed={feed} queryClient={queryClient} onLogout={onLogout} />;
}
