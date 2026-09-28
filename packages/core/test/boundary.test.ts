import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Dependency Rule (§3): the core names none of the tools. It may import
 * its own files, the shared protocol, and pure path arithmetic — nothing that
 * touches the disk, the network or another process.
 */
const ALLOWED = [/^\.\.?\//, /^@malves\/protocol$/, /^node:path$/];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("core boundary", () => {
  const root = new URL("../src", import.meta.url).pathname;
  const imports = sources(root).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => ({
        file: file.slice(root.length + 1),
        spec: m[1] ?? "",
      }),
    ),
  );

  it("finds the imports it checks", () => {
    expect(imports.length).toBeGreaterThan(5);
  });

  it("imports nothing but its own files, the protocol and node:path", () => {
    const leaks = imports.filter(({ spec }) => !ALLOWED.some((rule) => rule.test(spec)));
    expect(leaks).toEqual([]);
  });
});
