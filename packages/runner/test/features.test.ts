import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkFeatures } from "../../../scripts/check-features.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const good = {
  id: "thing",
  name: "A thing",
  area: "core",
  criticality: "hot",
  status: "automated-only",
  evidence: ["package.json"],
  real_test: "Do the thing on a real phone and see it.",
};
const check = (...features: object[]) => checkFeatures({ features }, root);

describe("features.json", () => {
  it("the real manifest passes, and lists what is still unproven", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
    const { errors, summary, todo } = checkFeatures(manifest, root);
    expect(errors).toEqual([]);
    expect(Object.values(summary).reduce((a, b) => a + b, 0)).toBe(manifest.features.length);
    expect(todo.length).toBeGreaterThan(0);
  });

  it("accepts a well-formed feature", () => {
    expect(check(good).errors).toEqual([]);
  });

  it("refuses a repeated id, a bad status and a bad criticality", () => {
    expect(check(good, good).errors.join("\n")).toContain("used twice");
    expect(check({ ...good, status: "done" }).errors.join("\n")).toContain("status must be");
    expect(check({ ...good, criticality: "urgent" }).errors.join("\n")).toContain("criticality");
  });

  it("evidence must exist", () => {
    expect(check({ ...good, evidence: ["nowhere/at-all.test.ts"] }).errors.join("\n")).toContain(
      "evidence file not found",
    );
    expect(check({ ...good, evidence: [] }).errors.join("\n")).toContain("needs evidence");
  });

  it("anything not proven on a real device must say how to prove it", () => {
    const { real_test: _gone, ...bare } = good;
    expect(check(bare).errors.join("\n")).toContain("real_test");
    expect(check({ ...bare, status: "verified-real" }).errors).toEqual([]);
  });

  it("a known issue must say what is wrong", () => {
    const issue = { ...good, status: "known-issue" };
    expect(check(issue).errors.join("\n")).toContain("known issue needs notes");
    expect(check({ ...issue, notes: "It does not start on Windows." }).errors).toEqual([]);
  });

  it("an empty or missing list is refused", () => {
    expect(checkFeatures({}, root).errors).not.toEqual([]);
    expect(checkFeatures({ features: [] }, root).errors).not.toEqual([]);
  });
});
