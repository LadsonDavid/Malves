import { type Lead, LeadsResponse } from "@malves/protocol";

/**
 * The lead engine (points 1 and 7): signalstack, a separate Python process
 * reached over HTTP — on this computer or a server. The runner never imports it.
 */
export type LeadSource = { fetch(): Promise<Lead[]> };

export function signalstack(o: {
  url: string;
  key?: string | undefined;
  timeoutMs?: number;
}): LeadSource {
  const endpoint = new URL("/api/leads?limit=25", o.url);
  return {
    async fetch() {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          // A header, not the URL: keys in URLs end up in logs.
          headers: o.key ? { "x-key": o.key } : {},
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
        });
      } catch {
        throw new Error(`Can't reach the lead engine at ${endpoint.origin}. Is it running?`);
      }
      if (response.status === 401) {
        throw new Error("The lead engine refused the key. Set MALVES_LEADS_KEY to its UI_KEY.");
      }
      if (!response.ok) {
        throw new Error(`The lead engine answered ${response.status} ${response.statusText}.`);
      }
      const body = LeadsResponse.safeParse(await response.json().catch(() => undefined));
      if (!body.success)
        throw new Error("The lead engine sent leads in a shape malves doesn't know.");
      return body.data.leads;
    },
  };
}
