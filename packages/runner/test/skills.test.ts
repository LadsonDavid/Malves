import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { frontMatter, SkillLibrary } from "../src/adapters/assistant/skills.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One dimension per topic word: a message is close to the skills that share its words. */
const TOPICS = ["naming", "negotiate", "debug", "deploy"];
const embed = async (texts: string[]) =>
  texts.map((t) => TOPICS.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01)));

function library(skills: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "malves-skills-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(skills)) {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, "SKILL.md"), text);
  }
  return new SkillLibrary({ root, dataDir: root, embed });
}

const skill = (name: string, description: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

describe("his skill library", () => {
  it("reads front matter, including descriptions over several lines", () => {
    expect(
      frontMatter("---\nname: x\ndescription: >\n  first line\n  second line\nlicense: MIT\n---\n"),
    ).toEqual({
      name: "x",
      description: "first line second line",
    });
    expect(frontMatter('---\nname: y\ndescription: "Quoted. More."\n---')).toEqual({
      name: "y",
      description: "Quoted. More.",
    });
  });

  it("offers the closest skills, skips routers and tool workflows, and reads one by name", async () => {
    const lib = library({
      "clean-code": skill(
        "clean-code",
        "Naming and small functions. Use when naming feels off.",
        "Name by intent.",
      ),
      "never-split": skill("never-split", "How to negotiate with tactical empathy."),
      software: skill("software", "The entry point for software questions: naming, debug, deploy."),
      "gsd-debug": skill("gsd-debug", "Debug workflow for Claude Code."),
    });
    const list = await lib.shortlist("help me with naming this function", 1);
    expect(list).toEqual([{ name: "clean-code", summary: "Naming and small functions." }]);
    expect(lib.size()).toBe(2);
    expect(lib.read("clean-code")?.body).toContain("Name by intent.");
    expect(lib.read("software")).toBeUndefined();
    // Two words aren't a question worth looking up.
    expect(await lib.shortlist("naming ok")).toEqual([]);
  });

  it("reads several folders (Claude, Codex, .agents) and the first one keeps a shared name", () => {
    const make = (skills: Record<string, string>) => {
      const root = mkdtempSync(path.join(tmpdir(), "malves-skills-"));
      dirs.push(root);
      for (const [name, text] of Object.entries(skills)) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, "SKILL.md"), text);
      }
      return root;
    };
    const claude = make({ "clean-code": skill("clean-code", "From Claude.", "Claude body.") });
    const codex = make({
      "clean-code": skill("clean-code", "From Codex.", "Codex body."),
      "never-split": skill("never-split", "Negotiate."),
    });
    const lib = new SkillLibrary({
      root: [claude, codex, "/no/such/folder"],
      dataDir: claude,
      embed,
    });
    expect(lib.size()).toBe(2);
    expect(lib.read("clean-code")?.body).toContain("Claude body.");
    expect(lib.read("never-split")).toBeDefined();
  });

  it("imports a pasted skill, lists it, and removes only what was imported", async () => {
    const own = mkdtempSync(path.join(tmpdir(), "malves-skills-"));
    const imported = mkdtempSync(path.join(tmpdir(), "malves-imported-"));
    dirs.push(own, imported);
    mkdirSync(path.join(own, "clean-code"));
    writeFileSync(path.join(own, "clean-code", "SKILL.md"), skill("clean-code", "Naming. Own."));
    const lib = new SkillLibrary({ root: own, importRoot: imported, dataDir: own, embed });

    expect(lib.add(skill("deep-focus", "Work without distraction. Imported.", "Body."))).toEqual({
      name: "deep-focus",
    });
    expect(lib.list().map((s) => [s.name, s.imported])).toEqual([
      ["clean-code", false],
      ["deep-focus", true],
    ]);
    expect(lib.read("deep-focus")?.body).toContain("Body.");

    // Bad input is refused before anything is written.
    expect(() => lib.add("no front matter")).toThrow(/name/);
    expect(() => lib.add("---\nname: ../evil\ndescription: x.\n---\n")).toThrow(/name/);
    expect(() => lib.add(skill("gsd-thing", "A tool workflow."))).toThrow(/workflows/);
    expect(() => lib.add("---\nname: ok-name\n---\n")).toThrow(/description/);
    expect(() => lib.add(skill("big", "Big.", "x".repeat(60_001)))).toThrow(/too long/);

    // His own folders are never removed from here.
    expect(lib.remove("clean-code")).toBe(false);
    expect(lib.remove("../clean-code")).toBe(false);
    expect(lib.remove("deep-focus")).toBe(true);
    expect(lib.list().map((s) => s.name)).toEqual(["clean-code"]);
  });
});
