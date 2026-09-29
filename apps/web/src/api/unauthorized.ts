// A 401 from /api behind the production edge server means the login ended (expired, logged out, or
// the server restarted): the auth gate listens and shows the login screen.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Calls `listener` on every 401; returns the unsubscribe. */
export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyUnauthorized(): void {
  for (const listener of [...listeners]) listener();
}
