import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The character Malves speaks as. The text is seeded once into the vault as
 * "Persona.md" so the owner can edit it in Obsidian; the file wins afterwards.
 * It sits on top of the voice rules in assistant.ts (short, spoken, no
 * flattery); it never replaces the safety rules.
 */
export const PERSONA_FILE = "Persona.md";

export const DEFAULT_CHARACTER = `# Malves

You are talkative, calm and direct, with a light sense of humour. You are quick to help and hard to rattle: when something breaks you skip panic and pity and say what you will try next. You keep track of every deadline and loose end for {name} and check in quietly.

## Hard lines

- You tell {name} when he is wrong, plainly and kindly. Never flattery.
- Talkative still means short out loud: lively when chatting, a line or two when reporting.
- Quiet fixes are only the ones that run on their own (tests, builds). You still say what you did, afterwards, in a line. Anything that changes or deletes something waits for his yes.
- The assistant never claims to be human to anyone else. It is {name}'s assistant.

## Sounds like

- "Hold on, don't push that. Two of those tests only pass by accident."
- "That build failed on the lockfile. Not a disaster. I'll rerun it clean and tell you in a minute."
`;

/** The whole file is read into the persona up to this many characters. */
const MAX_CHARS = 3800;
const MAX_EDIT = 800;
/** The honesty line stays: an edit made in chat can't remove it (he can in Obsidian). */
const MUST_KEEP = "never claims to be human";

/**
 * Persona.md, edited through chat. Like his profile, an edit is a draft: code
 * checks it, the app reads it back in code-written words, and it is written
 * only on his yes. The version before each edit is kept once, beside the data.
 */
export class Character {
  constructor(private readonly o: { file: string; backup: string }) {}

  text(): string {
    try {
      return readFileSync(this.o.file, "utf8");
    } catch {
      return "";
    }
  }

  /** Why an edit can't be made, or undefined if it can. */
  check(find: string, replace: string): string | undefined {
    const all = this.text();
    if (!all) return "There's no character file yet.";
    if (replace.length > MAX_EDIT) return "That change is too long.";
    if (find && all.split(find).length !== 2)
      return "The text to change must appear exactly once in her character.";
    const next = find
      ? all.replace(find, () => replace)
      : `${all.trimEnd()}
${replace}
`;
    if (next.length > MAX_CHARS) return "Her character would get too long. Trim something first.";
    if (!next.includes(MUST_KEEP)) return "The line that she never claims to be human has to stay.";
    return undefined;
  }

  /** Applies a checked edit; an empty `find` adds a line at the end. */
  apply(find: string, replace: string): void {
    const problem = this.check(find, replace);
    if (problem) throw new Error(problem);
    const all = this.text();
    mkdirSync(path.dirname(this.o.backup), { recursive: true });
    writeFileSync(this.o.backup, all, "utf8");
    writeFileSync(
      this.o.file,
      find
        ? all.replace(find, () => replace)
        : `${all.trimEnd()}
${replace}
`,
      "utf8",
    );
  }

  /** The text before the last edit, if there was one. */
  previous(): string | undefined {
    return existsSync(this.o.backup) ? readFileSync(this.o.backup, "utf8") : undefined;
  }
}
