import type { LeadDossier } from "@malves/protocol";
import { politeFetch } from "./collectors/polite.js";
import type { DbSignal } from "./db.js";

export type DossierReader = (url: string) => Promise<string | undefined>;

export type BuildDossierOptions = {
  domain: string;
  companyName: string;
  signals?: DbSignal[] | undefined;
  reader?: DossierReader | undefined;
};

/**
 * Extracts plain text sentences and metadata from raw HTML.
 */
function extractTextFromHtml(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = titleMatch ? titleMatch[1]!.trim() : "";

  // Strip script, style, nav, footer
  const stripped = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  return { title, text: stripped };
}

/**
 * Stage D3: Company Dossier Generator (§8).
 * Reads the company site and news/signals to produce a concise dossier with sources.
 */
export async function buildDossier(options: BuildDossierOptions): Promise<LeadDossier> {
  const { domain, companyName, signals = [] } = options;
  const sources: string[] = [];
  const readUrl: DossierReader =
    options.reader ??
    (async (url: string) => {
      const res = await politeFetch(url);
      return res ? await res.text() : undefined;
    });

  let siteText = "";
  const siteUrl = `https://${domain}`;
  try {
    const html = await readUrl(siteUrl);
    if (html) {
      sources.push(siteUrl);
      const parsed = extractTextFromHtml(html);
      siteText = parsed.text.slice(0, 1000);
    }
  } catch {
    // Site read failed: fallback to signals
  }

  // Key people extraction from signals or text
  const keyPeople: string[] = [];
  const recentSignals: string[] = [];

  for (const sig of signals) {
    if (sig.source_url && !sources.includes(sig.source_url)) {
      sources.push(sig.source_url);
    }
    recentSignals.push(`[${sig.type}] ${sig.summary}`);
    if (sig.type === "leadership" || sig.type === "contact") {
      keyPeople.push(sig.summary);
    }
  }

  // Generate summary
  const summary = siteText.length > 0
    ? `${companyName} (${domain}): ${siteText.slice(0, 300)}...`
    : `${companyName} is an active target with ${signals.length} tracked signals.`;

  return {
    domain,
    company_name: companyName,
    summary,
    key_people: keyPeople,
    recent_signals: recentSignals.slice(0, 5),
    sources,
    generated_at: Date.now(),
  };
}
