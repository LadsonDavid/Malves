import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type SessionInfo, type SessionMessage, type SessionSource, titleFrom } from "./types.js";

/**
 * Cursor's own editor chats. Listed and read from Cursor's database (read
 * only): composerData:<id> holds a chat, bubbleId:<id>:<bubble> its messages,
 * and each workspace's database says which chats belong to which folder.
 *
 * Continuing goes through Cursor's Desktop Bridge (Settings → Beta → "Allow
 * CLI to access desktop agents"): Cursor itself puts the message into the
 * chat. Without it, a chat can only be read.
 *
 * Built from Cursor's format as of Oct 2026; not yet tried on real chats.
 */
export function cursorSessions(userDir = cursorUserDir()): SessionSource & {
  send(threadId: string, text: string): Promise<string>;
  bridgeOn(): boolean;
} {
  const globalDb = path.join(userDir, "globalStorage", "state.vscdb");
  return {
    tool: "cursor",
    async list() {
      if (!existsSync(globalDb)) return [];
      const folders = chatFolders(userDir);
      const bridge = bridgeOn();
      const rows =
        withDb(
          globalDb,
          (db) =>
            db
              .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
              .all() as Array<{ key: string; value: string }>,
        ) ?? [];
      const out: SessionInfo[] = [];
      for (const row of rows) {
        const chat = parse<Composer>(row.value);
        if (!chat?.composerId || chat.composerId === "empty-state-draft") continue;
        const headers = chat.fullConversationHeadersOnly ?? [];
        const firstText = chat.text?.trim();
        if (headers.length === 0 && !chat.name && !firstText) continue; // an empty new chat
        out.push({
          tool: "cursor",
          id: chat.composerId,
          title: chat.name?.trim() || titleFrom(firstText, "Cursor chat"),
          folder: folders.get(chat.composerId),
          updatedAt: chat.lastUpdatedAt ?? chat.createdAt ?? statSync(globalDb).mtimeMs,
          how: bridge ? "bridge" : "new",
          source: "editor",
        });
      }
      return out;
    },
    async read(id, limit) {
      if (!/^[\w-]{8,64}$/.test(id)) throw new Error("Unknown Cursor chat.");
      const messages = withDb(globalDb, (db) => {
        const row = db
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`composerData:${id}`) as { value: string } | undefined;
        const chat = row ? parse<Composer>(row.value) : undefined;
        const out: SessionMessage[] = [];
        const bubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
        for (const h of chat?.fullConversationHeadersOnly ?? []) {
          const b = parse<{ type?: number; text?: string }>(
            (bubble.get(`bubbleId:${id}:${h.bubbleId}`) as { value: string } | undefined)?.value ??
              "",
          );
          const text = b?.text?.trim();
          // 1 = you, 2 = the agent.
          if (text)
            out.push({
              who: (b?.type ?? h.type) === 1 ? "you" : "agent",
              text: text.slice(0, 4000),
            });
        }
        return out;
      });
      if (!messages) throw new Error("Cursor's chats can't be read right now.");
      return messages.slice(-limit);
    },
    bridgeOn,
    async send(threadId, text) {
      const bridge = discovery();
      if (!bridge) {
        throw new Error(
          "Cursor's Desktop Bridge is off. In Cursor: Settings → Beta → Allow CLI to access desktop agents, then restart Cursor.",
        );
      }
      const answer = await post(bridge, { type: "sendMessage", threadId, text });
      const outcome = (
        answer as { outcome?: string; threadTitle?: string; reason?: string; message?: string }
      )?.outcome;
      if (outcome === "submitted" || outcome === "queued") {
        return `Sent to Cursor${outcome === "queued" ? " (queued: the agent is busy)" : ""}.`;
      }
      if (outcome === "not-found")
        throw new Error("Cursor doesn't have that chat open in any window.");
      if (outcome === "not-sendable")
        throw new Error(
          `Cursor can't take a message in that chat now: ${(answer as { reason?: string }).reason}`,
        );
      throw new Error(
        (answer as { message?: string })?.message ?? "Cursor didn't take the message.",
      );
    },
  };
}

type Composer = {
  composerId?: string;
  name?: string;
  text?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type?: number }>;
};

type Discovery = { socketPath: string; token: string; pid?: number };

/** Cursor writes ~/.cursor/desktop-bridge/<hash>.json while the bridge runs. */
function discovery(): Discovery | undefined {
  const dir =
    process.env.CURSOR_DESKTOP_BRIDGE_DIR ?? path.join(homedir(), ".cursor", "desktop-bridge");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const found = names
    .map((n) => parse<Discovery & { createdAt?: number }>(readFileSync(path.join(dir, n), "utf8")))
    .filter((d): d is Discovery & { createdAt?: number } => !!d?.socketPath && !!d.token)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return found[0];
}

export function bridgeOn(): boolean {
  return discovery() !== undefined;
}

/** One request to the bridge: HTTP over Cursor's local pipe, with its token. */
function post(bridge: Discovery, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        socketPath: bridge.socketPath,
        path: "/",
        method: "POST",
        headers: {
          authorization: `Bearer ${bridge.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
        timeout: 15_000,
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          text += c.toString();
        });
        res.on("end", () => resolve(parse(text) ?? {}));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Cursor didn't answer in time.")));
    req.on("error", () =>
      reject(new Error("Couldn't reach Cursor's Desktop Bridge. Is Cursor open?")),
    );
    req.end(data);
  });
}

/** Which folder each chat belongs to, from every workspace's own database. */
function chatFolders(userDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const root = path.join(userDir, "workspaceStorage");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return map;
  }
  for (const d of dirs) {
    const ws = parse<{ folder?: string }>(safeRead(path.join(root, d, "workspace.json")));
    if (!ws?.folder?.startsWith("file:")) continue;
    let folder: string;
    try {
      folder = fileURLToPath(ws.folder);
    } catch {
      continue;
    }
    const ids = withDb(path.join(root, d, "state.vscdb"), (db) => {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value: string } | undefined;
      return (
        parse<{ allComposers?: Array<{ composerId?: string }> }>(row?.value ?? "")?.allComposers ??
        []
      )
        .map((c) => c.composerId)
        .filter((x): x is string => !!x);
    });
    for (const id of ids ?? []) map.set(id, folder);
  }
  return map;
}

function cursorUserDir(): string {
  const appData = process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming");
  return process.platform === "win32"
    ? path.join(appData, "Cursor", "User")
    : process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "Cursor", "User")
      : path.join(homedir(), ".config", "Cursor", "User");
}

function withDb<T>(file: string, read: (db: Database.Database) => T): T | undefined {
  if (!existsSync(file)) return undefined;
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

function parse<T>(text: string): T | undefined {
  try {
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

function safeRead(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
