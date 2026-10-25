/**
 * Started at login, malves can come up before Tailscale does. After waiting a
 * while it serves on this computer only, which no phone can reach. This notices
 * when Tailscale arrives, so serve can start again and bind to it. Calls
 * `onUp` once, with the address, then stops. Returns a function that stops it.
 */
export function watchForTailscale(
  current: () => string | undefined,
  onUp: (address: string) => void,
  everyMs = 10_000,
): () => void {
  const timer = setInterval(() => {
    const address = current();
    if (!address) return;
    clearInterval(timer);
    onUp(address);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
