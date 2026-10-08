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
});
