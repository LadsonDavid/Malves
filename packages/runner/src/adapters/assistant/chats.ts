import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { redact } from "../../redact.js";

/**
 * His chats with Malves. A normal chat is a Markdown file in the vault
 * (Chats/…md) he can read and edit in Obsidian, and what he says in it is
 * remembered. A temp chat lives in memory only: it is never written to the
 * vault, the conversation log or memory, and it is gone when malves restarts,
 * unless he saves it, which turns it into a normal chat.
 *
 * File format, one block per message:
 *   ### you · 2026-11-06T22:14:00.000Z
 *   text…
 * ponytail: the list is rebuilt by reading the folder; fine to a few thousand chats.
 */
export type ChatMeta = {
  id: string;
  title: string;
  temp: boolean;
  created: number;
  updated: number;
  preview: string;
};
export type ChatLine = { who: "you" | "malves"; text: string; at: number };

export const CHATS_FOLDER = "Chats";
const MAX_LINES = 400;
const MAX_TEMP = 20;

type Temp = { meta: ChatMeta; lines: ChatLine[] };

export class ChatStore {
  private readonly temps = new Map<string, Temp>();
  private readonly now: () => number;

  constructor(private readonly o: { vault: string; now?: () => number }) {
    this.now = o.now ?? Date.now;
  }

  private dir(): string {
    return path.join(this.o.vault, CHATS_FOLDER);
  }

  /** A new empty chat. Temp ones exist only in memory. */
  create(temp: boolean): ChatMeta {
    const at = this.now();
    const meta: ChatMeta = {
      id: `chat-${at.toString(36)}-${randomBytes(3).toString("hex")}`,
      title: temp ? "Temp chat" : "New chat",
      temp,
      created: at,
      updated: at,
      preview: "",
    };
    if (temp) {
      this.temps.set(meta.id, { meta, lines: [] });
      // A forgotten temp chat doesn't pile up: the oldest go first.
      for (const old of [...this.temps.values()]
        .sort((a, b) => a.meta.updated - b.meta.updated)
        .slice(0, Math.max(0, this.temps.size - MAX_TEMP)))
        this.temps.delete(old.meta.id);
    } else this.write(meta, []);
    return meta;
  }

  isTemp(id: string): boolean {
    return this.temps.has(id);
  }

  /** The chat for `id`, making a normal one if it is new (the voice conversation, for instance). */
  ensure(id: string): ChatMeta {
    const known = this.meta(id);
    if (known) return known;
    const at = this.now();
    const meta: ChatMeta = {
      id,
      title: id.startsWith("app-") ? "Voice conversation" : "New chat",
      temp: false,
      created: at,
      updated: at,
      preview: "",
    };
    this.write(meta, []);
    return meta;
  }

  list(): ChatMeta[] {
    const out = [...this.temps.values()].map((t) => t.meta);
    for (const name of safeDir(this.dir())) {
      if (!name.endsWith(".md")) continue;
      const parsed = this.read(path.join(this.dir(), name));
      if (parsed) out.push(parsed.meta);
    }
    return out.sort((a, b) => b.updated - a.updated);
  }

  get(id: string): { meta: ChatMeta; lines: ChatLine[] } | undefined {
    const temp = this.temps.get(id);
    if (temp) return { meta: temp.meta, lines: temp.lines };
    const file = this.fileOf(id);
    return file ? this.read(file) : undefined;
  }

  private meta(id: string): ChatMeta | undefined {
    return this.temps.get(id)?.meta ?? this.get(id)?.meta;
  }

  /** Adds one message. Normal chats are written to the vault at once. */
  add(id: string, who: ChatLine["who"], text: string): void {
    const chat = this.get(id);
    if (!chat || !text.trim()) return;
    const at = this.now();
    chat.lines.push({ who, text: text.trim(), at });
    if (chat.lines.length > MAX_LINES) chat.lines.splice(0, chat.lines.length - MAX_LINES);
    chat.meta.updated = at;
    const first = chat.lines.find((l) => l.who === "you");
    if (first && /^(New chat|Temp chat|Voice conversation)$/.test(chat.meta.title))
      chat.meta.title = titleFrom(first.text);
    chat.meta.preview = oneLine(chat.lines.at(-1)?.text ?? "").slice(0, 90);
    if (!chat.meta.temp) this.write(chat.meta, chat.lines);
  }

  /** Turns a temp chat into a normal one. Only now is it written down. */
  save(id: string): ChatMeta | undefined {
    const temp = this.temps.get(id);
    if (!temp) return this.get(id)?.meta;
    this.temps.delete(id);
    temp.meta.temp = false;
    if (temp.meta.title === "Temp chat") temp.meta.title = "Saved chat";
    this.write(temp.meta, temp.lines);
    return temp.meta;
  }

  remove(id: string): boolean {
    if (this.temps.delete(id)) return true;
    const file = this.fileOf(id);
    if (!file) return false;
    unlinkSync(file);
    this.files.delete(id);
    return true;
  }

  private readonly files = new Map<string, string>();

  private fileOf(id: string): string | undefined {
    const cached = this.files.get(id);
    if (cached && existsSync(cached)) return cached;
    for (const name of safeDir(this.dir())) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(this.dir(), name);
      if (head(file).includes(`\nid: ${id}\n`)) {
        this.files.set(id, file);
        return file;
      }
    }
    return undefined;
  }

  private write(meta: ChatMeta, lines: ChatLine[]): void {
    mkdirSync(this.dir(), { recursive: true });
    const old = this.fileOf(meta.id);
    const stamp = new Date(meta.created).toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const file = path.join(this.dir(), `${stamp} ${slug(meta.title)}-${meta.id.slice(-4)}.md`);
    const body = lines
      .map(
        (l) =>
          `### ${l.who} · ${new Date(l.at).toISOString()}\n${redact(l.text).replace(/^### /gm, "\\### ")}\n`,
      )
      .join("\n");
    const text = `---\nid: ${meta.id}\ntitle: ${oneLine(meta.title)}\ncreated: ${new Date(meta.created).toISOString()}\nupdated: ${new Date(meta.updated).toISOString()}\n---\n\n${body}`;
    writeFileSync(file, text, "utf8");
    this.files.set(meta.id, file);
    // A renamed chat keeps one file, not two.
    if (old && old !== file && existsSync(old)) unlinkSync(old);
  }

  private read(file: string): { meta: ChatMeta; lines: ChatLine[] } | undefined {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const field = (k: string) => front.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1]?.trim() ?? "";
    const id = field("id");
    if (!id) return undefined;
    const lines: ChatLine[] = [];
    const blocks = text.split(/^### (you|malves) · (\S+)\r?\n/m);
    for (let i = 1; i + 2 < blocks.length; i += 3) {
      const who = blocks[i];
      const at = Date.parse(blocks[i + 1] ?? "");
      const body = (blocks[i + 2] ?? "").trim().replace(/^\\### /gm, "### ");
      if ((who === "you" || who === "malves") && body) {
        lines.push({ who, text: body, at: Number.isNaN(at) ? 0 : at });
      }
    }
    const created = Date.parse(field("created")) || statSync(file).birthtimeMs;
    const updated = Date.parse(field("updated")) || statSync(file).mtimeMs;
    return {
      meta: {
        id,
        title: field("title") || "Chat",
        temp: false,
        created,
        updated,
        preview: oneLine(lines.at(-1)?.text ?? "").slice(0, 90),
      },
      lines,
    };
  }

  /** Renames a normal chat's file after its title changed (kept for tidy folders). */
  rename(id: string, title: string): void {
    const chat = this.get(id);
    if (!chat) return;
    chat.meta.title = oneLine(title).slice(0, 60) || chat.meta.title;
    if (!chat.meta.temp) this.write(chat.meta, chat.lines);
  }
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function head(file: string): string {
  try {
    return readFileSync(file, "utf8").slice(0, 600);
  } catch {
    return "";
  }
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const titleFrom = (s: string) => oneLine(s).slice(0, 48) || "Chat";
const slug = (s: string) =>
  oneLine(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "chat";
