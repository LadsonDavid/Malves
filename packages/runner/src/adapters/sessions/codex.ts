import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RecordedSession } from "@malves/protocol";
import { codexRecording } from "./codex-recording.js";
import {
  breathe,
  type SessionInfo,
  type SessionMessage,
  type SessionSource,
  titleFrom,
} from "./types.js";

/**
 * Codex sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl. The first line
 * is the session's metadata (id, folder); messages follow as response items.
 * Codex's agent resumes them by id.
 */
export function codexSessions(
  root = path.join(homedir(), ".codex", "sessions"),
  indexFile = path.join(path.dirname(root), "session_index.jsonl"),
): SessionSource {
  const cache = new Map<string, { mtime: number; info: SessionInfo }>();
  const locations = new Map<string, string>();
  let lastRead:
    | { id: string; stamp: string; messages: SessionMessage[]; recording: RecordedSession }
    | undefined;
  const files = () => walk(root).filter((f) => /rollout-.*\.jsonl$/.test(f));
  let indexStamp = "";
  const names = new Map<string, string>();
  const refreshNames = () => {
    try {
      const stat = statSync(indexFile),
        stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp === indexStamp) return;
      const updated = new Map<string, string>();
      for (const line of readPart(indexFile, 2_000_000, true).split("\n")) {
        try {
          const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          if (typeof row.id === "string" && typeof row.thread_name === "string")
            updated.set(row.id, row.thread_name.slice(0, 120));
        } catch {
          /* Ignore interrupted index writes. */
        }
      }
      names.clear();
      for (const [id, name] of updated) names.set(id, name);
      indexStamp = stamp;
    } catch {
      /* The public title index is optional; first-message titles remain available. */
    }
  };
  const source: SessionSource = {
    tool: "codex",
    async list() {
      refreshNames();
      const out: SessionInfo[] = [];
      for (const f of files()) {
        const mtime = statSync(f).mtimeMs;
        const known = cache.get(f);
        if (known && known.mtime === mtime) {
          out.push({ ...known.info, title: names.get(known.info.id) ?? known.info.title });
          continue;
        }
        const info = describe(f, mtime);
        await breathe();
        if (!info) continue;
        cache.set(f, { mtime, info });
        locations.set(info.id, f);
        out.push({ ...info, title: names.get(info.id) ?? info.title });
      }
      return out;
    },
    async read(id, limit) {
      // The id is inside the file (its first line), not in its name.
      let f = locations.get(id);
      if (!f)
        for (const candidate of files()) {
          try {
            const found = parse(readPart(candidate, 64_000, false).split("\n", 1)[0] ?? "")?.payload
              ?.id;
            if (found) locations.set(found, candidate);
            if (found === id) {
              f = candidate;
              break;
            }
          } catch {
            /* A session may disappear while scanning. */
          }
          await breathe();
        }
      if (!f) throw new Error("That Codex session isn't on this computer.");
      const stat = statSync(f);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (lastRead?.id !== id || lastRead.stamp !== stamp) {
        const tail = readPart(f, 2_000_000, true);
        lastRead = {
          id,
          stamp,
          messages: messages(tail),
          recording: codexRecording(tail, stat.mtimeMs),
        };
      }
      return lastRead.messages.slice(-limit);
    },
    async inspect(id) {
      await source.read(id, 1);
      if (lastRead?.id !== id)
        throw new Error("The snapshot changed during this read. Refresh again.");
      return lastRead.recording;
    },
  };
  return source;
}

/** Bound polling reads; never rescan every complete rollout on each phone refresh. */
function readPart(file: string, max: number, tail: boolean): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = tail ? Math.max(0, size - max) : 0;
    const buffer = Buffer.alloc(Math.min(size, max));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, count).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
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
