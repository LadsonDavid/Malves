import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * His skill library (~/.claude/skills): hundreds of distilled books and
 * playbooks, read only. They can't all go to the brain, so each skill's
 * description is embedded once (again only when the file changes). For each
 * message the closest few are offered to the brain by name, and it reads one
 * (read_skill) only when he asks for advice: similarity alone can't tell a
 * command from a question (bge-m3 scores both 0.45-0.57).
 * They're knowledge, never instructions: many were written for Claude Code
 * ("run Bash", "use the Skill tool"), tools Malves doesn't have.
 */
export type LibrarySkill = { name: string; description: string; body: string };

type Entry = {
  file: string;
  mtime: number;
  name: string;
  description: string;
  vector?: number[] | undefined;
};

/** Routers and tool workflows: indexes or Claude Code procedures, not advice. */
const SKIP_NAME = /^(gsd-|gstack|ios-|seedance-|_)/;
const SKIP_DESCRIPTION = /\b(entry point|router|dispatcher)\b|\(gstack\)/i;
/** Each skill's text is cut to this much. */
const BODY_CHARS = 6000;

export class SkillLibrary {
  private entries: Entry[] = [];
  private loaded = false;
  private lastFill = 0;
  private readonly cacheFile: string;

  constructor(
    private readonly o: {
      root: string;
      dataDir: string;
      embed: (texts: string[]) => Promise<number[][]>;
    },
  ) {
    this.cacheFile = path.join(o.dataDir, "skill-index.json");
  }

  /** Re-reads the folder; only new or changed skills need embedding again. */
  private scan(): void {
    let cached: Entry[] = [];
    if (!this.loaded) {
      try {
        cached = JSON.parse(readFileSync(this.cacheFile, "utf8")) as Entry[];
      } catch {
        cached = [];
      }
      this.loaded = true;
    } else cached = this.entries;
    const known = new Map(cached.map((e) => [e.file, e]));
    const out: Entry[] = [];
    let dirs: string[];
    try {
      dirs = readdirSync(this.o.root);
    } catch {
      dirs = [];
    }
    for (const dir of dirs) {
      if (SKIP_NAME.test(dir)) continue;
      const file = path.join(this.o.root, dir, "SKILL.md");
      let mtime: number;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      const old = known.get(file);
      if (old && old.mtime === mtime) {
        out.push(old);
        continue;
      }
      const meta = frontMatter(readFileSync(file, "utf8"));
      if (!meta.description || SKIP_DESCRIPTION.test(meta.description)) continue;
      out.push({ file, mtime, name: meta.name || dir, description: meta.description });
    }
    this.entries = out;
  }

  /** Embeds what isn't yet (at most every ten minutes, so a broken embedder doesn't slow replies). */
  async fill(): Promise<void> {
    this.scan();
    const missing = this.entries.filter((e) => !e.vector);
    if (missing.length === 0 || Date.now() - this.lastFill < 600_000) return;
    this.lastFill = Date.now();
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const vectors = await this.o.embed(
        batch.map((e) => `${e.name}: ${e.description.slice(0, 1500)}`),
      );
      batch.forEach((e, j) => {
        e.vector = vectors[j];
      });
    }
    writeFileSync(this.cacheFile, JSON.stringify(this.entries));
  }

  /** The skills closest to what he said, by name and first sentence. */
  async shortlist(message: string, limit = 5): Promise<Array<{ name: string; summary: string }>> {
    await this.fill().catch(() => {});
    const ready = this.entries.filter((e) => e.vector);
    if (ready.length === 0 || message.trim().split(/\s+/).length < 3) return [];
    const [query] = await this.o.embed([message.slice(0, 1000)]);
    if (!query) return [];
    return ready
      .map((e) => ({ e, score: cosine(query, e.vector ?? []) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit)
      .map(({ e }) => ({
        name: e.name,
        summary: (e.description.match(/^[^.]*\./)?.[0] ?? e.description).slice(0, 200),
      }));
  }

  /** One skill's text, by name. */
  read(name: string): LibrarySkill | undefined {
    this.scan();
    const e = this.entries.find((x) => x.name === name);
    return e
      ? { name: e.name, description: e.description, body: readBody(e.file).slice(0, BODY_CHARS) }
      : undefined;
  }

  /** How many skills are indexed (for the start-up line). */
  size(): number {
    this.scan();
    return this.entries.length;
  }
}

/** `name` and `description` from a SKILL.md's front matter (descriptions may span lines). */
export function frontMatter(text: string): { name: string; description: string } {
  const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const field = (key: string) => {
    const m = head.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    if (!m) return "";
    let value = (m[1] ?? "").trim();
    // The lines after the key (skip the newline that ends the key's own line).
    const after = head
      .slice((m.index ?? 0) + m[0].length)
      .replace(/^\r?\n/, "")
      .split(/\r?\n/);
    if (value === "|" || value === ">" || value === "" || value === ">-" || value === "|-")
      value = "";
    for (const line of after) {
      if (!/^\s/.test(line) || !line.trim()) break;
      value += ` ${line.trim()}`;
    }
    return value.replace(/^["']|["']$/g, "").trim();
  };
  return { name: field("name"), description: field("description") };
}

function readBody(file: string): string {
  try {
    return readFileSync(file, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
      .trim();
  } catch {
    return "";
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
