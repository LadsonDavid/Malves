import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Fitness functions (architecture rules that must keep holding as the code
 * changes). Each one scans the source and fails with the line that broke it.
 */
const src = fileURLToPath(new URL("../src", import.meta.url));

function* sources(dir = src): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

const lines = (file: string) => readFileSync(file, "utf8").split("\n");
const rel = (file: string) => path.relative(src, file).replaceAll("\\", "/");

describe("fitness functions", () => {
  it("secrets are written only through secure-file.ts", () => {
    const secret = /token|secretKey|private_key|\.key\b/i;
    const offenders: string[] = [];
    for (const file of sources()) {
      if (rel(file) === "secure-file.ts") continue;
      lines(file).forEach((line, i) => {
        if (/\bwriteFileSync\(/.test(line) && secret.test(line)) {
          offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
