export const USER_AGENT = "Malves/1.0 (+https://github.com/LadsonDavid/Malves; automated polite collector)";

export type FetchOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
};

const domainLastRequest = new Map<string, number>();
const MIN_DOMAIN_GAP_MS = 500;

/**
 * Polite HTTP request helper:
 * - Enforces minimum interval per host (rate limit)
 * - Identifies bot clearly via User-Agent
 * - Handles JSON and text
 */
export async function politeFetch(
  url: string,
  options: FetchOptions = {},
): Promise<{ status: number; text: () => Promise<string>; json: <T = unknown>() => Promise<T> }> {
  let hostname = "unknown";
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Malformed URL, fallback to unknown
  }

  const last = domainLastRequest.get(hostname) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < MIN_DOMAIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_DOMAIN_GAP_MS - elapsed));
  }
  domainLastRequest.set(hostname, Date.now());

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });

  return {
    status: response.status,
    text: () => response.text(),
    json: () => response.json() as Promise<any>,
  };
}
