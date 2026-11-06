/** Pieces of Malves' reply as they are written, per command (the chat screen's streaming). */
const listeners = new Map<string, Set<(text: string) => void>>();
export function deliverDelta(commandId: string, text: string): void {
  for (const listener of listeners.get(commandId) ?? []) listener(text);
}
export function watchDelta(commandId: string, listener: (text: string) => void): () => void {
  const set = listeners.get(commandId) ?? new Set();
  set.add(listener);
  listeners.set(commandId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(commandId);
  };
}
