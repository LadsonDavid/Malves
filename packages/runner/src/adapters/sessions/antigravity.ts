import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  breathe,
  type SessionInfo,
  type SessionMessage,
  type SessionSource,
  titleFrom,
} from "./types.js";

/**
 * Antigravity's own editor conversations: ~/.gemini/antigravity-ide/conversations/<id>.db,
 * SQLite with protobuf blobs and no published schema. Read only, never written.
 *
 * What we read (found by inspection, Antigravity IDE, Oct 2026):
 * - folder: the first file:/// address in trajectory_metadata_blob
 * - your message: steps of type 14, field 19.2
 * - the agent's visible reply: steps of type 15, field 20.1 (20.3 is its private thinking)
 * - the title: steps of type 23, field 30.4
 * If an update moves these, the conversation just shows no messages (never garbage),
 * and the test in antigravity-sessions.test.ts says so.
 *
 * They can't be continued from outside safely (that would drive the editor's
 * Google login), so "continue" starts a new Antigravity session in the same
 * folder through the API key, told what happened so far.
 */
export function antigravitySessions(
  root = path.join(homedir(), ".gemini", "antigravity-ide", "conversations"),
): SessionSource {
  const cache = new Map<string, { mtime: number; info: SessionInfo }>();
  return {
    tool: "antigravity",
    async list() {
      const out: SessionInfo[] = [];
      for (const name of safeList(root).filter((n) => n.endsWith(".db"))) {
        const full = path.join(root, name);
        const mtime = newest(full);
        const known = cache.get(full);
        if (known && known.mtime === mtime) {
          out.push(known.info);
          continue;
        }
        const info = withDb(full, (db) => describe(db, name.slice(0, -3), mtime));
        await breathe();
        if (!info) continue;
        cache.set(full, { mtime, info });
        out.push(info);
      }
      return out;
    },
    async read(id, limit) {
      if (!/^[\w-]{8,64}$/.test(id)) throw new Error("Unknown Antigravity conversation.");
      const messages = withDb(path.join(root, `${id}.db`), (db) => conversation(db));
      if (!messages) throw new Error("That Antigravity conversation isn't on this computer.");
      return messages.slice(-limit);
    },
  };
}

function describe(db: Database.Database, id: string, mtime: number): SessionInfo | undefined {
  // Not every conversation has this table: the folder is then unknown, the rest still reads.
  let meta: { data: Buffer } | undefined;
  try {
    meta = db.prepare("SELECT data FROM trajectory_metadata_blob").get() as
      | { data: Buffer }
      | undefined;
  } catch {
    meta = undefined;
  }
  const folderUrl = meta
    ? fields(meta.data).find(([, t]) => t.startsWith("file:///"))?.[1]
    : undefined;
  let title: string | undefined;
  let first: string | undefined;
  for (const row of steps(db)) {
    if (row.step_type === 23) title ??= pick(row.step_payload, "/30/4");
    if (row.step_type === 14) first ??= pick(row.step_payload, "/19/2");
    if (title && first) break;
  }
  if (!title && !first) return undefined;
  return {
    tool: "antigravity",
    id,
    title: title ?? titleFrom(first, "Antigravity conversation"),
    folder: folderUrl ? toPath(folderUrl) : undefined,
    updatedAt: mtime,
    how: "new",
    source: "editor",
  };
}

function conversation(db: Database.Database): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const row of steps(db)) {
    if (row.step_type === 14) {
      const text = pick(row.step_payload, "/19/2");
      if (text) out.push({ who: "you", text: text.slice(0, 4000) });
    } else if (row.step_type === 15) {
      const text = pick(row.step_payload, "/20/1");
      if (text) out.push({ who: "agent", text: text.slice(0, 4000) });
    }
  }
  return out;
}

type Step = { step_type: number; step_payload: Buffer | null };
function steps(db: Database.Database): Step[] {
  return db.prepare("SELECT step_type, step_payload FROM steps ORDER BY idx").all() as Step[];
}

/** The first text found at a field path like "/19/2". */
function pick(payload: Buffer | null, at: string): string | undefined {
  if (!payload) return undefined;
  return fields(payload).find(([p]) => p === at)?.[1];
}

/** Text, not bytes: tabs, line breaks and any printable character. */
const READABLE = /^[\t\n\r \x20-\x7E\u00A0-\uFFFF]+$/;

/**
 * Every text field in a protobuf message, with its field-number path. The wire
 * format says where each length-delimited field starts and ends; a field that
 * reads as clean text is text, otherwise it's tried as a nested message.
 */
export function fields(buf: Buffer, trail = "", depth = 0, out: Array<[string, string]> = []) {
  let i = 0;
  const varint = () => {
    let value = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = buf[i++] ?? 0;
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128 && i < buf.length);
    return value;
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const length = varint();
      if (length < 0 || i + length > buf.length) return out;
      const sub = buf.subarray(i, i + length);
      i += length;
      const text = sub.toString("utf8");
      if (length > 0 && !text.includes("\uFFFD") && READABLE.test(text)) {
        out.push([`${trail}/${field}`, text]);
      } else if (depth < 12) {
        fields(sub, `${trail}/${field}`, depth + 1, out);
      }
    } else return out; // not protobuf (any more): stop rather than guess
  }
  return out;
}

function toPath(url: string): string | undefined {
  try {
    return fileURLToPath(
      url.replace(/^file:\/\/\/([a-z])(%3A|:)/i, (_m, d) => `file:///${d.toUpperCase()}:`),
    );
  } catch {
    return undefined;
  }
}

/** The db or its write-ahead log, whichever changed last. */
function newest(file: string): number {
  let t = statSync(file).mtimeMs;
  try {
    t = Math.max(t, statSync(`${file}-wal`).mtimeMs);
  } catch {
    // no WAL file
  }
  return t;
}

function withDb<T>(file: string, read: (db: Database.Database) => T): T | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return read(db);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
