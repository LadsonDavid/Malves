import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { type Core, samePath } from "@malves/core";
import { antigravitySessions } from "./antigravity.js";
import { claudeSessions } from "./claude.js";
import { codexSessions } from "./codex.js";
import { cursorSessions } from "./cursor.js";
import type { SessionInfo, SessionMessage, SessionSource, Tool } from "./types.js";

export type { SessionInfo, SessionMessage, Tool } from "./types.js";

/**
 * All your sessions, across tools, and the folders they ran in. Folders
 * replace hand-added "projects": the phone may start work in any folder that
 * already appears in your own sessions (or that you added on the computer).
 * A brand-new folder still has to be added on the computer.
 */
export class Sessions {
  private readonly cursor = cursorSessions();
  private readonly sources: SessionSource[];
  private last: SessionInfo[] = [];

  constructor(
    private readonly core: Core,
    sources?: SessionSource[],
  ) {
    this.sources = sources ?? [
      claudeSessions(),
      codexSessions(),
      this.cursor,
      antigravitySessions(),
    ];
  }

  /** Newest first, across every tool (or one). */
  async list(tool?: Tool, limit = 500): Promise<SessionInfo[]> {
    const all = (
      await Promise.all(this.sources.map((s) => s.list().catch(() => [] as SessionInfo[])))
    ).flat();
    this.last = all;
    return all
      .filter((s) => !tool || s.tool === tool)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async read(tool: Tool, id: string, limit = 40): Promise<SessionMessage[]> {
    const source = this.sources.find((s) => s.tool === tool);
    if (!source) throw new Error(`Unknown tool: ${tool}`);
    return source.read(id, limit);
  }

  /** Every folder you can work in from the phone: added ones, then those from sessions. */
  async folders(): Promise<Array<{ path: string; name: string; lastUsed: number }>> {
    const seen = new Map<string, { path: string; name: string; lastUsed: number }>();
    for (const w of this.core.workspaces.list()) {
      seen.set(key(w.path), { path: w.path, name: w.name, lastUsed: 0 });
    }
    for (const s of this.last.length ? this.last : await this.list()) {
      if (!s.folder || !isFolder(s.folder)) continue;
      const k = key(s.folder);
      const known = seen.get(k);
      if (known) known.lastUsed = Math.max(known.lastUsed, s.updatedAt);
      else seen.set(k, { path: s.folder, name: path.basename(s.folder), lastUsed: s.updatedAt });
    }
    return [...seen.values()].sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /**
   * The project (workspace) for a folder, added on first use. Only folders you
   * added on the computer or already worked in with one of the tools.
   */
  async workspaceFor(folder: string): Promise<string> {
    const resolved = path.resolve(folder);
    const known = (await this.folders()).find((f) => samePath(f.path, resolved));
    if (!known) {
      throw new Error(
        "That folder isn't one you've worked in. Add it on the computer first: pnpm malves console add <folder>.",
      );
    }
    return this.core.workspaces.register(known.name, known.path).id;
  }

  /**
   * Continues a session with a new message. Returns the new task's id, or what
   * Cursor said when the message went into its own chat.
   */
  async continue(
    tool: Tool,
    id: string,
    text: string,
    ready: (agent: string) => boolean,
  ): Promise<{ taskId?: string; result: string }> {
    const info = (this.last.length ? this.last : await this.list()).find(
      (s) => s.tool === tool && s.id === id,
    );
    if (!info) throw new Error("That session isn't on this computer any more.");
    if (info.how === "bridge") return { result: await this.cursor.send(id, text) };
    if (!info.folder) throw new Error("I don't know which folder that session ran in.");
    const workspaceId = await this.workspaceFor(info.folder);

    if (info.how === "resume") {
      if (!ready(tool)) throw new Error(`${label(tool)} isn't ready on the computer.`);
      const taskId = this.core.tasks.create({ workspaceId, agent: tool, prompt: text, resume: id });
      return { taskId, result: `${label(tool)} is continuing "${info.title}".` };
    }

    // A fresh session in the same folder, told what happened so far.
    if (!ready(tool)) {
      throw new Error(
        tool === "cursor"
          ? "Turn on Cursor's Desktop Bridge (Settings → Beta → Allow CLI to access desktop agents) to continue its chats, or install Cursor's CLI."
          : `${label(tool)} isn't ready on the computer.`,
      );
    }
    const history = await this.read(tool, id, 10).catch(() => [] as SessionMessage[]);
    const prompt = continuation(label(tool), info.title, history, text);
    const taskId = this.core.tasks.create({ workspaceId, agent: tool, prompt });
    return {
      taskId,
      result: `Started a new ${label(tool)} session following on from "${info.title}".`,
    };
  }
}

/** The opening message of a session that follows on from one that can't be resumed. */
export function continuation(
  tool: string,
  title: string,
  history: SessionMessage[],
  next: string,
): string {
  let budget = 3500;
  const lines: string[] = [];
  for (const m of [...history].reverse()) {
    const line = `${m.who === "you" ? "Me" : "You"}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return [
    `This continues an earlier ${tool} conversation in this folder, titled "${title}". What happened so far:`,
    "",
    ...lines,
    "",
    `Now: ${next}`,
  ].join("\n");
}

const LABELS: Record<Tool, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};
const label = (tool: Tool) => LABELS[tool];

const key = (p: string) => (path.sep === "\\" ? path.resolve(p).toLowerCase() : path.resolve(p));

function isFolder(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
