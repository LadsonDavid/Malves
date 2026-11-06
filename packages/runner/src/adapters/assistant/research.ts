import type { MemoryNote } from "./memory.js";

export type Research = {
  steps: string[];
  sources: Array<{ title: string; location: string; excerpt: string }>;
};

/** Only evidence actually read: bounded work notes and the owner's current Chrome tab. */
export async function researchContext(
  question: string,
  deps: {
    recall(query: string): Promise<MemoryNote[]>;
    page?: (() => Promise<unknown>) | undefined;
  },
): Promise<Research> {
  const sources: Research["sources"] = [];
  const steps: string[] = [];
  const notes = await deps.recall(question.slice(0, 500)).catch(() => []);
  for (const note of notes.slice(0, 4)) {
    if (/(^|[\\/])ladson\.md$/i.test(note.file)) continue;
    sources.push({
      title: note.title.slice(0, 120),
      location: `Work vault: ${note.file.slice(0, 200)}`,
      excerpt: note.text.slice(0, 800),
    });
  }
  steps.push(`Read ${sources.length} relevant work notes.`);
  if (deps.page) {
    try {
      const page = (await deps.page()) as { url?: unknown; title?: unknown; text?: unknown };
      const url = new URL(typeof page.url === "string" ? page.url : "");
      if (url.href.length > 2000) throw new Error("source URL too long");
      if (!/^https?:$/.test(url.protocol) || url.username || url.password)
        throw new Error("unsupported source");
      // Query strings and fragments can contain credentials; do not turn them into citations.
      if (url.search || url.hash) throw new Error("source URL contains query or fragment");
      if (typeof page.text !== "string" || !page.text.trim()) throw new Error("no readable text");
      sources.push({
        title: typeof page.title === "string" ? page.title.slice(0, 120) : "Current Chrome page",
        location: url.href,
        excerpt: page.text.slice(0, 1800),
      });
      steps.push("Read the current Chrome page; recorded its source URL.");
    } catch {
      steps.push("Could not include the current Chrome page as a readable source.");
    }
  } else steps.push("Chrome is not connected; no web page was read.");
  steps.push("Bounded context collected. No web search or additional pages were fetched.");
  return { steps, sources };
}

export function researchEvidence(research: Research): string {
  return research.sources
    .map(
      (source, i) =>
        `[S${i + 1}] ${source.title}\n${source.location}\n<data>${source.excerpt}</data>`,
    )
    .join("\n\n");
}
