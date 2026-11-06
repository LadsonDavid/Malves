import { expect, it } from "vitest";
import { publicResearchUrl, researchWeb } from "../src/adapters/assistant/research-web.js";

it("searches and reads bounded actual pages, reports progress, and never cites a failed page", async () => {
  const visited: string[] = [];
  const progress: string[] = [];
  const result = await researchWeb(
    "test query",
    async (url) => {
      visited.push(url);
      if (url.includes("google.com/search"))
        return {
          url,
          elements: [
            { href: "https://example.com/one" },
            { href: "https://example.com/two" },
            { href: "http://127.0.0.1/private" },
            { href: "https://example.com/three" },
            { href: "https://example.com/four" },
          ],
        };
      if (url.endsWith("two")) throw new Error("unavailable");
      return { url, title: "Read page", text: "evidence".repeat(1000) };
    },
    (text) => progress.push(text),
  );
  expect(visited).toHaveLength(4);
  expect(result.sources).toHaveLength(2);
  expect(result.sources.every((source) => source.excerpt.length <= 2500)).toBe(true);
  expect(result.sources.some((source) => source.location.endsWith("two"))).toBe(false);
  expect(progress).toEqual(result.steps);
});
it("rejects private, credential-bearing and non-web result URLs", () => {
  for (const url of [
    "file:///private",
    "http://localhost/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "https://user:pass@example.com/",
    "https://example.com/?token=secret",
    "http://service.internal/",
  ])
    expect(publicResearchUrl(url)).toBeUndefined();
  expect(publicResearchUrl("https://example.com/a#section")).toBe("https://example.com/a");
});
it("does not invent sources for an empty/captcha search", async () => {
  const result = await researchWeb("query", async (url) => ({ url, elements: [] }));
  expect(result.sources).toEqual([]);
});
