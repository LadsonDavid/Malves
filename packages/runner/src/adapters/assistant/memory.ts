import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Malves' long-term memory. The notes are the memory: plain Markdown in an
 * Obsidian vault you can read, fix or delete. Each says when it became true and,
 * once replaced, until when (so "I moved to the website project" supersedes the
 * old fact instead of contradicting it). A SQLite index with embeddings sits on
 * top for fast "what's related?" lookups; it is rebuilt from the notes, so
 * losing it loses nothing.
 *
 * Ideas from MemGPT/Letta (the model edits its own memory through tools),
 * Mem0 (facts merged instead of piling up) and Graphiti (validity in time);
 * the code is malves' own.
 */
export type MemoryKind = "fact" | "preference" | "person" | "project" | "lesson" | "skill";

export const MEMORY_FOLDERS: Record<MemoryKind, string> = {
  fact: "Facts",
  preference: "Preferences",
  person: "People",
  project: "Projects",
  lesson: "Lessons",
  skill: "Skills",
};

export type MemoryNote = {
  id: string;
  kind: MemoryKind;
  title: string;
  text: string;
  validFrom: string;
  validTo?: string;
  source?: string;
  /** Relative to the vault. */
  file: string;
};

/** Two notes of one kind this similar are the same memory: the newer replaces the older. */
const SAME = 0.9;
/** Below this (cosine) a note is unrelated: bge-m3 scores even unrelated text about 0.35. */
const RELATED = 0.38;

type Row = {
  file: string;
  mtime: number;
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  valid_from: string;
  valid_to: string | null;
  source: string | null;
  vector: Buffer | null;
};

export class Memory {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private lastFill = 0;

  constructor(
    private readonly o: {
      vault: string;
      indexFile: string;
      embed?: ((texts: string[]) => Promise<number[][]>) | undefined;
      now?: () => Date;
    },
  ) {
    this.now = o.now ?? (() => new Date());
    mkdirSync(o.vault, { recursive: true });
    this.db = new Database(o.indexFile);
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS notes (
          file TEXT PRIMARY KEY, mtime REAL, id TEXT, kind TEXT, title TEXT, body TEXT,
          valid_from TEXT, valid_to TEXT, source TEXT, vector BLOB)`,
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  /** Re-reads notes changed in the vault (by you in Obsidian, or by Malves) and drops deleted ones. */
  async sync(): Promise<void> {
    const seen = new Set<string>();
    const changed: Array<{ file: string; mtime: number; note: MemoryNote }> = [];
    const rows = this.db.prepare("SELECT file, mtime FROM notes").all() as Array<{
      file: string;
      mtime: number;
    }>;
    const known = new Map(rows.map((r) => [r.file, r.mtime]));
    for (const [kind, folder] of Object.entries(MEMORY_FOLDERS) as Array<[MemoryKind, string]>) {
      const dir = path.join(this.o.vault, folder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const file = path.join(folder, name);
        seen.add(file);
        const mtime = statSync(path.join(this.o.vault, file)).mtimeMs;
        if (known.get(file) === mtime) continue;
        const note = parseNote(readFileSync(path.join(this.o.vault, file), "utf8"), kind, file);
        if (note) changed.push({ file, mtime, note });
      }
    }
    for (const file of known.keys()) {
      if (!seen.has(file)) this.db.prepare("DELETE FROM notes WHERE file = ?").run(file);
    }
    await this.fillMissingVectors(seen);
    if (changed.length === 0) return;
    const vectors = await this.vectors(changed.map((c) => `${c.note.title}\n${c.note.text}`));
    const upsert = this.db.prepare(
      `INSERT OR REPLACE INTO notes (file, mtime, id, kind, title, body, valid_from, valid_to, source, vector)
       VALUES (@file, @mtime, @id, @kind, @title, @body, @valid_from, @valid_to, @source, @vector)`,
    );
    changed.forEach(({ file, mtime, note }, i) => {
      const vector = vectors?.[i];
      upsert.run({
        file,
        mtime,
        id: note.id,
        kind: note.kind,
        title: note.title,
        body: note.text,
        valid_from: note.validFrom,
        valid_to: note.validTo ?? null,
        source: note.source ?? null,
        vector: vector ? Buffer.from(new Float32Array(vector).buffer) : null,
      });
    });
  }

  /** Remembers something. A very similar current note of the same kind is replaced (kept, marked as past). */
  async remember(input: {
    kind: MemoryKind;
    text: string;
    title?: string | undefined;
    source?: string | undefined;
  }): Promise<MemoryNote> {
    await this.sync();
    const text = input.text.trim();
    const title = (input.title?.trim() || firstWords(text)).slice(0, 80);
    const [vector] = (await this.vectors([`${title}\n${text}`])) ?? [];
    const stamp = this.now().toISOString();
    for (const old of this.currentRows().filter((r) => r.kind === input.kind)) {
      const sameTitle = old.title.toLowerCase() === title.toLowerCase();
      const similar = vector && old.vector ? cosine(vector, toVector(old.vector)) >= SAME : false;
      if (sameTitle || similar) this.markPast(old.file, stamp);
    }
    const id = `${input.kind[0]}-${stamp.slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
    const note: MemoryNote = {
      id,
      kind: input.kind,
      title,
      text,
      validFrom: stamp,
      ...(input.source ? { source: input.source } : {}),
      file: path.join(MEMORY_FOLDERS[input.kind], `${slug(title)}-${id.slice(-6)}.md`),
    };
    mkdirSync(path.join(this.o.vault, MEMORY_FOLDERS[input.kind]), { recursive: true });
    writeFileSync(path.join(this.o.vault, note.file), formatNote(note), "utf8");
    await this.sync();
    return note;
  }

  /** The current notes most related to `query`, best first. */
  async recall(query: string, limit = 6, min = RELATED): Promise<MemoryNote[]> {
    await this.sync();
    const rows = this.currentRows();
    if (rows.length === 0) return [];
    const [q] = (await this.vectors([query])) ?? [];
    const words = new Set(normalizeWords(query));
    const scored = rows.map((r) => ({
      r,
      score:
        q && r.vector
          ? cosine(q, toVector(r.vector))
          : normalizeWords(`${r.title} ${r.body}`).filter((w) => words.has(w)).length /
            (words.size || 1),
    }));
    // Unrelated notes stay out: they'd only crowd the brain's context.
    return scored
      .filter(({ r, score }) => (q && r.vector ? score >= min : score > 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => toNote(r));
  }

  /** Everything currently true, newest first — for the phone's Memory screen. */
  async list(): Promise<MemoryNote[]> {
    await this.sync();
    return this.currentRows()
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))
      .map(toNote);
  }

  /** Deletes a memory for good (your data: "forget that" means gone). */
  forget(id: string): MemoryNote | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as Row | undefined;
    if (!row) return undefined;
    const full = path.join(this.o.vault, row.file);
    if (existsSync(full)) unlinkSync(full);
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    return toNote(row);
  }

  /** One line in today's conversation log (Conversations/2026-10-05.md), for you to read back. */
  logConversation(line: string): void {
    const day = this.now().toISOString().slice(0, 10);
    const dir = path.join(this.o.vault, "Conversations");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${day}.md`);
    if (!existsSync(file)) writeFileSync(file, `# Conversations ${day}\n\n`, "utf8");
    const time = this.now().toISOString().slice(11, 16);
    appendFileSync(file, `- ${time} ${line.replace(/\s*\n\s*/g, " ")}\n`, "utf8");
  }

  /**
   * Notes saved while embeddings were down get theirs later, so they're found
   * by meaning, not just by words. Tried at most every ten minutes, so a broken
   * embedding service doesn't slow every reply.
   */
  private async fillMissingVectors(present: Set<string>): Promise<void> {
    if (!this.o.embed || Date.now() - this.lastFill < 10 * 60_000) return;
    const rows = (
      this.db
        .prepare("SELECT file, title, body FROM notes WHERE vector IS NULL LIMIT 25")
        .all() as Array<{
        file: string;
        title: string;
        body: string;
      }>
    ).filter((r) => present.has(r.file));
    if (rows.length === 0) return;
    this.lastFill = Date.now();
    const vectors = await this.vectors(rows.map((r) => `${r.title}\n${r.body}`));
    if (!vectors) return;
    const update = this.db.prepare("UPDATE notes SET vector = ? WHERE file = ?");
    rows.forEach((r, i) => {
      const v = vectors[i];
      if (v) update.run(Buffer.from(new Float32Array(v).buffer), r.file);
    });
  }

  private currentRows(): Row[] {
    const now = this.now().toISOString();
    return (this.db.prepare("SELECT * FROM notes").all() as Row[]).filter(
      (r) => !r.valid_to || r.valid_to > now,
    );
  }

  private markPast(file: string, stamp: string): void {
    const full = path.join(this.o.vault, file);
    if (!existsSync(full)) return;
    const content = readFileSync(full, "utf8");
    const updated = /^valid_to:.*$/m.test(content)
      ? content.replace(/^valid_to:.*$/m, `valid_to: ${stamp}`)
      : content.replace(/^valid_from:.*$/m, (line) => `${line}\nvalid_to: ${stamp}`);
    writeFileSync(full, updated, "utf8");
  }

  private async vectors(texts: string[]): Promise<number[][] | undefined> {
    if (!this.o.embed || texts.length === 0) return undefined;
    try {
      return await this.o.embed(texts);
    } catch {
      // ponytail: no embeddings → keyword matching; fine for a few hundred notes.
      return undefined;
    }
  }
}

export function formatNote(note: MemoryNote): string {
  return [
    "---",
    `id: ${note.id}`,
    `kind: ${note.kind}`,
    `valid_from: ${note.validFrom}`,
    ...(note.validTo ? [`valid_to: ${note.validTo}`] : []),
    ...(note.source ? [`source: ${note.source}`] : []),
    "---",
    "",
    `# ${note.title}`,
    "",
    note.text,
    "",
  ].join("\n");
}

/** Reads a note written by Malves or by you; anything unreadable is skipped. */
export function parseNote(content: string, kind: MemoryKind, file: string): MemoryNote | undefined {
  const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const head: Record<string, string> = {};
  for (const line of (match?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = (match ? match[2] : content) ?? "";
  const titleLine = body.match(/^#\s+(.+)$/m);
  const text = body.replace(/^#\s+.+$/m, "").trim();
  if (!text && !titleLine) return undefined;
  return {
    id: head.id || `x-${slug(file)}`,
    kind,
    title: titleLine?.[1]?.trim() || firstWords(text),
    text,
    validFrom: head.valid_from || new Date(0).toISOString(),
    ...(head.valid_to ? { validTo: head.valid_to } : {}),
    ...(head.source ? { source: head.source } : {}),
    file,
  };
}

function toNote(r: Row): MemoryNote {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    text: r.body,
    validFrom: r.valid_from,
    ...(r.valid_to ? { validTo: r.valid_to } : {}),
    ...(r.source ? { source: r.source } : {}),
    file: r.file,
  };
}

function toVector(blob: Buffer): number[] {
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const p = a[i] ?? 0;
    const q = b[i] ?? 0;
    dot += p * q;
    x += p * p;
    y += q * q;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}

function firstWords(text: string): string {
  return text.split(/\s+/).slice(0, 8).join(" ");
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "note"
  );
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
}
