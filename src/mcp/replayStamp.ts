/**
 * One-tick handshake between `replay()` and the fetch proxy that records it.
 *
 * `replay()` sets the mark immediately before calling `fetch`, so `beforeFetch`
 * (which runs synchronously in the same tick, before any other request can be
 * issued) reads it, stamps the new item with the source id and reports the new
 * item's own id back through the same object.
 */

export interface ReplayMark {
  sourceId: string;
  /** id of the network item the proxy created for the replayed request */
  newItemId?: string;
}

let current: ReplayMark | null = null;

export function markReplay(sourceId: string): ReplayMark {
  current = { sourceId };
  return current;
}

/** Read and clear, so only the very next request can ever be stamped. */
export function takeReplayMark(): ReplayMark | null {
  const mark = current;
  current = null;
  return mark;
}

/**
 * Drop a mark nobody read — reached only when `fetch` is not the vConsole proxy
 * (a third-party getter-only `window.fetch`), where no item is recorded at all.
 */
export function clearReplayMark() {
  current = null;
}
