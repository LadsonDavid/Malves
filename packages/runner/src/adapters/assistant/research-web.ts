import type { Research } from "./research.js";

export function publicResearchUrl(value: string, base?: string): string | undefined {
  try {
    const u = new URL(value, base);
    const host = u.hostname.toLowerCase();
    if (
      !/^https?:$/.test(u.protocol) ||
      u.username ||
      u.password ||
      u.href.length > 2000 ||
      !host.includes(".") ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) ||
      /^[\d.]+$/.test(host) ||
      host.includes(":")
    )
      return;
    if ([...u.searchParams.keys()].some((key) => /token|secret|password|api.?key|auth/i.test(key)))
      return;
    u.hash = "";
    return u.href;
  } catch {
    return;
  }
}

/** Real Chrome, bounded navigation, no form submission or separate automation browser. */
export async function researchWeb(
  question: string,
  read: (url: string) => Promise<unknown>,
  progress: (text: string) => void = () => {},
): Promise<Research> {
  const steps: string[] = [];
  const sources: Research["sources"] = [];
  const step = (text: string) => {
    steps.push(text);
    progress(text);
  };
  const query = question.trim().slice(0, 500);
  if (!query) throw new Error("A research question is required.");
  step("Searching the web in your Chrome profile.");
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const search = (await read(searchUrl)) as { url?: string; elements?: Array<{ href?: string }> };
  if (!search?.url || new URL(search.url).hostname !== "www.google.com")
    throw new Error("The search page could not be verified.");
  const urls = new Set<string>();
  for (const link of (search.elements ?? []).slice(0, 200)) {
    let href = link.href ?? "";
    try {
      const wrapped = new URL(href, searchUrl);
      if (wrapped.hostname === "www.google.com" && wrapped.pathname === "/url")
        href = wrapped.searchParams.get("q") ?? wrapped.searchParams.get("url") ?? "";
    } catch {
      continue;
    }
    const url = publicResearchUrl(href, searchUrl);
    if (
      !url ||
      /(^|\.)(google\.[a-z.]+|youtube\.com|accounts\.[a-z.]+)$/.test(new URL(url).hostname)
    )
      continue;
    urls.add(url);
    if (urls.size === 3) break;
  }
  step(`Selected ${urls.size} public source pages; search snippets are not cited as read pages.`);
  for (const url of urls) {
    step(`Reading ${new URL(url).hostname}.`);
    try {
      const page = (await read(url)) as { url?: string; title?: string; text?: string };
      const actual = page?.url && publicResearchUrl(page.url);
      if (!actual || typeof page.text !== "string" || !page.text.trim())
        throw new Error("unreadable");
      if (!sources.some((source) => source.location === actual))
        sources.push({
          title: (page.title ?? new URL(actual).hostname).slice(0, 120),
          location: actual,
          excerpt: page.text.slice(0, 2500),
        });
      step(`Read source ${sources.length}: ${new URL(actual).hostname}.`);
    } catch {
      step(`Could not read ${new URL(url).hostname}; it is not cited.`);
    }
  }
  step(
    `Finished with ${sources.length} read sources. Maximum three pages, bounded excerpts; no clicks or form submissions.`,
  );
  return { steps, sources };
}
