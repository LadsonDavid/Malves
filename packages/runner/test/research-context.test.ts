import { expect, it } from "vitest";
import type { MemoryNote } from "../src/adapters/assistant/memory.js";
import { researchContext, researchEvidence } from "../src/adapters/assistant/research.js";

const note = (file = "Projects/project.md"): MemoryNote => ({
  id: "note",
  kind: "project",
  title: "Project decision",
  text: "x".repeat(2000),
  file,
  validFrom: "2026-11-06",
});
it("records only read sources, bounds evidence, and excludes the personal profile", async () => {
  const result = await researchContext("q".repeat(1000), {
    recall: async (query) => {
      expect(query.length).toBe(500);
      return [note(), note("ladson.md")];
    },
    page: async () => ({
      url: "https://example.test/project",
      title: "Project",
      text: "p".repeat(10000),
    }),
  });
  expect(result.sources).toHaveLength(2);
  expect(result.sources[0]?.excerpt).toHaveLength(800);
  expect(result.sources[1]?.excerpt).toHaveLength(1800);
  expect(researchEvidence(result)).toContain("[S2]");
  expect(result.steps.join(" ")).toContain("No web search");
});
it("does not invent sources when reads fail or URLs contain credentials", async () => {
  for (const url of [
    "file:///private",
    "https://user:pass@example.test/",
    "https://example.test/?token=secret",
  ]) {
    const result = await researchContext("q", {
      recall: async () => {
        throw new Error("unavailable");
      },
      page: async () => ({ url, text: "data" }),
    });
    expect(result.sources).toEqual([]);
  }
  expect((await researchContext("q", { recall: async () => [] })).steps.join(" ")).toContain(
    "no web page was read",
  );
});
