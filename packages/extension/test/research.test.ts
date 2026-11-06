import { expect, it } from "vitest";
import { researchAddress } from "../src/research.js";

it("permits public search/source pages and rejects private or credential-bearing redirects", () => {
  expect(researchAddress("https://www.google.com/search?q=public+question").hostname).toBe(
    "www.google.com",
  );
  expect(researchAddress("https://example.com/source").pathname).toBe("/source");
  for (const url of [
    "file:///private",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://service.local/",
    "https://user:pass@example.com/",
    "https://example.com/?token=secret",
  ])
    expect(() => researchAddress(url)).toThrow();
});
