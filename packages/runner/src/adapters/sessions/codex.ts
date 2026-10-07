import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type SessionInfo, type SessionMessage, type SessionSource, titleFrom } from "./types.js";

/**
 * Codex sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl. The first line
 * is the session's metadata (id, folder); messages follow as response items.
 * Codex's agent resumes them by id.
 */
export function codexSessions(root = path.join(homedir(), ".codex", "sessions")): SessionSource {
  const cache = new Map<string, { mtime: number; info: SessionInfo }>();
  const files = () => walk(root).filter((f) => /rollout-.*\.jsonl$/.test(f));
  return {
    tool: "codex",
    async list() {
      const out: SessionInfo[] = [];
      for (const f of files()) {
        const mtime = statSync(f).mtimeMs;
        const known = cache.get(f);
        if (known && known.mtime === mtime) {
          out.push(known.info);
          continue;
        }
        const info = describe(f, mtime);
        if (!info) continue;
        cache.set(f, { mtime, info });
        out.push(info);
      }
      return out;
    },
    async read(id, limit) {
      // The id is inside the file (its first line), not in its name.
      const f = files().find(
        (x) => parse(readFileSync(x, "utf8").split("\n", 1)[0] ?? "")?.payload?.id === id,
      );
      if (!f) throw new Error("That Codex session isn't on this computer.");
      return messages(readFileSync(f, "utf8")).slice(-limit);
    },
  };
}

type Line = {
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

function describe(file: string, mtime: number): SessionInfo | undefined {
  const text = readFileSync(file, "utf8");
  const meta = parse(text.split("\n", 1)[0] ?? "");
  const id = meta?.type === "session_meta" ? meta.payload?.id : undefined;
  if (!id) return undefined;
  const first = messages(text).find((m) => m.who === "you")?.text;
  if (!first) return undefined;
  return {
    tool: "codex",
    id,
    title: titleFrom(first, "Codex session"),
    folder: meta?.payload?.cwd,
    updatedAt: mtime,
    how: "resume",
  };
}

function messages(text: string): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const raw of text.split("\n")) {
    const l = parse(raw);
    const p = l?.payload;
    if (l?.type !== "response_item" || p?.type !== "message") continue;
    if (p.role !== "user" && p.role !== "assistant") continue;
    const t = (p.content ?? [])
      .map((c) => (c.type === "input_text" || c.type === "output_text" ? (c.text ?? "") : ""))
      .join("\n")
      .trim();
    // Codex adds its own instructions as "user" turns wrapped in tags: skip those.
    if (t && !t.startsWith("<"))
      out.push({ who: p.role === "user" ? "you" : "agent", text: t.slice(0, 4000) });
  }
  return out;
}

function parse(line: string): Line | undefined {
  try {
    return line.trim() ? (JSON.parse(line) as Line) : undefined;
  } catch {
    return undefined;
  }
}

function walk(dir: string, depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const full = path.join(dir, n);
    if (n.endsWith(".jsonl")) return [full];
    return depth < 4 ? walk(full, depth + 1) : [];
  });
}
