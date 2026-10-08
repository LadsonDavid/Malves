import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  breathe,
  type SessionInfo,
  type SessionMessage,
  type SessionSource,
  titleFrom,
} from "./types.js";

/**
 * Claude Code sessions: ~/.claude/projects/<folder>/<session id>.jsonl, one
 * JSON line per event. The same files back the terminal, the desktop app's
 * Code tab and the IDE extension, so all of them show up here, and Claude
 * Code's agent can resume any of them by id.
 */
export function claudeSessions(root = path.join(homedir(), ".claude", "projects")): SessionSource {
  const cache = new Map<string, { mtime: number; info: SessionInfo }>();
  const file = (id: string) => {
    for (const dir of safeList(root)) {
      const f = path.join(root, dir, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
    return undefined;
  };
  return {
    tool: "claude",
    async list() {
      const out: SessionInfo[] = [];
      for (const dir of safeList(root)) {
        for (const name of safeList(path.join(root, dir))) {
          if (!name.endsWith(".jsonl")) continue;
          const full = path.join(root, dir, name);
          const mtime = statSync(full).mtimeMs;
          const known = cache.get(full);
          if (known && known.mtime === mtime) {
            out.push(known.info);
            continue;
          }
          const info = describe(full, name.slice(0, -6), mtime);
          await breathe();
          if (!info) continue;
          cache.set(full, { mtime, info });
          out.push(info);
        }
      }
      return out;
    },
    async read(id, limit) {
      const f = /^[\w-]{8,64}$/.test(id) ? file(id) : undefined;
      if (!f) throw new Error("That Claude Code session isn't on this computer.");
      const messages: SessionMessage[] = [];
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const e = parse(line);
        if (!e || (e.type !== "user" && e.type !== "assistant") || e.isSidechain) continue;
        const text = textOf(e.message?.content);
        if (text) messages.push({ who: e.type === "user" ? "you" : "agent", text });
      }
      return messages.slice(-limit);
    },
  };
}

type Entry = {
  type?: string;
  cwd?: string;
  customTitle?: string;
  summary?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
};

const CUSTOM_TITLE = '"type":"custom-title"';
const SUMMARY = '"type":"summary"';
const CWD = '"cwd":"';
const USER = '"type":"user"';

/**
 * The folder, the title you gave it (the latest one) and the first request.
 * Found by searching the text, so big sessions don't need every line parsed.
 */
function describe(file: string, id: string, mtime: number): SessionInfo | undefined {
  const text = readFileSync(file, "utf8");
  const lineAt = (index: number): Entry | undefined => {
    if (index < 0) return undefined;
    const start = text.lastIndexOf("\n", index) + 1;
    const end = text.indexOf("\n", index);
    return parse(text.slice(start, end < 0 ? undefined : end));
  };
  const titled = lineAt(text.lastIndexOf(CUSTOM_TITLE));
  const summary = lineAt(text.lastIndexOf(SUMMARY));
  const folder = lineAt(text.indexOf(CWD))?.cwd;
  let first: string | undefined;
  for (let at = text.indexOf(USER); at >= 0 && !first; at = text.indexOf(USER, at + 1)) {
    const e = lineAt(at);
    if (e?.type === "user" && !e.isSidechain) first = textOf(e.message?.content);
  }
  const title = titled?.customTitle ?? summary?.summary;
  // A session with no request at all is a stub the app made: not worth listing.
  if (!first && !title) return undefined;
  return {
    tool: "claude",
    id,
    title: title ?? titleFrom(first, "Claude Code session"),
    folder,
    updatedAt: mtime,
    how: "resume",
  };
}

/** Plain text of a message: strings and text parts; tool results and thinking are skipped. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .filter(
      (p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text);
  return parts.length ? clean(parts.join("\n")) : undefined;
}

/** Drops the wrappers Claude Code adds around commands and reminders. */
function clean(text: string): string | undefined {
  const t = text
    .replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, "")
    .trim();
  return t.length > 0 ? t.slice(0, 4000) : undefined;
}

function parse(line: string): Entry | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as Entry;
  } catch {
    return undefined;
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
