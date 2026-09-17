/**
 * A tiny in-process event bus for the progress stream the setup wizard watches.
 * Web and worker can run as separate containers, so the web process also listens for
 * Postgres NOTIFY — see subscribeToDatabase below.
 */

export type AppEvent =
  | { type: "sync:start"; connectionId: string; tenantId: string; stream: string }
  | {
      type: "sync:done";
      connectionId: string;
      tenantId: string;
      stream: string;
      stats: Record<string, number>;
    }
  | { type: "sync:error"; connectionId: string; tenantId: string; stream: string; error: string }
  | { type: "discovery:done"; connectionId: string; summary: Record<string, number> };

type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();
let forwarder: ((event: AppEvent) => void) | null = null;

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: AppEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // a broken SSE client must never break a sync
    }
  }
  forwarder?.(event);
}

/** Called by the worker so events reach web replicas through Postgres. */
export function setForwarder(fn: ((event: AppEvent) => void) | null): void {
  forwarder = fn;
}
