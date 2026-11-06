import { politeFetch } from "./polite.js";

export type HnHiringPost = {
  id: number;
  companyName: string;
  domain?: string | undefined;
  role: string;
  url?: string | undefined;
  text: string;
  timestamp: number;
};

/**
 * Extracts hiring postings from Hacker News "Who is Hiring" comment text.
 * Example HN format:
 * "Company Name | Senior TypeScript Engineer | Remote (US) | https://example.com"
 */
export function parseHnComment(
  id: number,
  text: string,
  time = Date.now(),
): HnHiringPost | undefined {
  const clean = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
  const firstLine = clean.split("\n")[0] ?? clean;
  const parts = firstLine.split("|").map((p) => p.trim());

  if (parts.length >= 2) {
    const companyName = parts[0]!;
    const role = parts[1]!;
    let domain: string | undefined;
    let url: string | undefined;

    // Look for URL in the parts or text
    const urlMatch = clean.match(/https?:\/\/[^\s"',)]+/);
    if (urlMatch) {
      url = urlMatch[0];
      try {
        domain = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        // Invalid URL format
      }
    }

    if (!domain && companyName) {
      domain = `${companyName.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
    }

    return {
      id,
      companyName,
      domain,
      role,
      url,
      text: clean.slice(0, 500),
      timestamp: time,
    };
  }

  return undefined;
}

/** Fetches items from Hacker News Firebase API without login. */
async function fetchHnItem(
  itemId: number,
  fetchFn: typeof politeFetch = politeFetch,
): Promise<{ id: number; text?: string; by?: string; time?: number; kids?: number[] } | undefined> {
  const res = await fetchFn(`https://hacker-news.firebaseio.com/v0/item/${itemId}.json`);
  if (res.status !== 200) return undefined;
  return (await res.json()) as any;
}
