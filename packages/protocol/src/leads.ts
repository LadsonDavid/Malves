/**
 * The lead engine (signalstack) is its own endpoint (§7): the phone talks to
 * it directly — over Tailscale in topology A, through the relay's /leads route
 * in B — and the runner never depends on it. This is how the phone learns
 * where it is and which key to present.
 */

export type LeadsInvite = { url: string; key: string };

export type Lead = {
  domain: string;
  name: string;
  score: number;
  tier: "hot" | "warm" | "cold" | string;
  types: string[];
  /** Why this company is on the list (R7). */
  why: string;
  trigger: string;
  signals: number;
  contact: { name: string; title: string } | null;
};

export type LeadsPage = { as_of: string; leads: Lead[] };

export function encodeLeadsInvite(invite: LeadsInvite): string {
  return `malves://leads?u=${encodeURIComponent(invite.url)}&k=${encodeURIComponent(invite.key)}`;
}

export function decodeLeadsInvite(text: string): LeadsInvite {
  const prefix = "malves://leads?";
  if (!text.startsWith(prefix)) throw new Error("Not a lead engine code");
  const fields = new Map(
    text
      .slice(prefix.length)
      .split("&")
      .map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const;
      }),
  );
  const url = fields.get("u") ?? "";
  const key = fields.get("k") ?? "";
  if (!/^https?:\/\/[^\s]+$/.test(url))
    throw new Error("The lead engine code has an invalid address");
  if (!key) throw new Error("The lead engine code has no key");
  return { url: url.replace(/\/+$/, ""), key };
}

/** The task a phone starts from a lead: the phone carries the data between the two systems. */
export function researchPrompt(lead: Lead): string {
  const who = lead.contact ? ` A likely contact: ${lead.contact.name}, ${lead.contact.title}.` : "";
  return (
    `Research ${lead.name} (${lead.domain}) on the web. Why they are on my list: ${lead.why}.` +
    `${lead.trigger ? ` Latest trigger: ${lead.trigger}.` : ""}${who}` +
    " Summarise what they do, any sign they need what I offer, and the best way to open a conversation." +
    " Read only: do not fill in forms or contact anyone."
  );
}
