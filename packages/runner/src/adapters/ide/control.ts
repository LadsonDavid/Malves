import path from "node:path";
import { samePath, type Workspace } from "@malves/core";
import type { IdeInfo } from "@malves/protocol";
import type { IdeControl } from "../link/server.js";
import type { IdeBridge } from "./bridge.js";

/** What the phone may ask of an open IDE, on top of the IDE bridge. */
export function ideControl(
  bridge: IdeBridge,
  o: {
    workspaces: () => Workspace[];
    workspace: (id: string) => Workspace | undefined;
    changedFiles: (taskId: string) => { root: string; files: string[] } | undefined;
    agentLabel: (agent: string) => string;
  },
): IdeControl {
  return {
    list: () =>
      bridge.list().map(
        (w): IdeInfo => ({
          id: w.id,
          app: w.app,
          projects: w.folders.map((folder) => {
            const ws = o.workspaces().find((x) => related(x.path, folder));
            return {
              name: path.basename(folder) || folder,
              ...(ws ? { workspace_id: ws.id } : {}),
            };
          }),
        }),
      ),
    onChange: (listener) => bridge.onChange(listener),
    agent: (ideId, prompt) => bridge.call(ideId, "agent", { prompt }),
    async openChanges(ideId, taskId) {
      const changed = o.changedFiles(taskId);
      if (!changed || changed.files.length === 0) {
        throw new Error("This task has no recorded changes to open.");
      }
      return bridge.call(ideId, "open", changed);
    },
    async resume(ideId, workspaceId, agent, sessionId) {
      const ws = o.workspace(workspaceId);
      if (!ws) throw new Error(`Unknown project: ${workspaceId}`);
      const command = resumeCommand(agent, sessionId);
      if (!command) throw new Error(`${o.agentLabel(agent)} can't be reopened in a terminal.`);
      return bridge.call(ideId, "terminal", {
        cwd: ws.path,
        name: `malves · ${o.agentLabel(agent)}`,
        command,
      });
    },
  };
}

/**
 * The terminal command that continues a conversation in the agent's own CLI.
 * The id is checked again here: it goes onto a command line.
 */
export function resumeCommand(agent: string, sessionId: string): string | undefined {
  if (!/^[\w.:-]{1,128}$/.test(sessionId)) return undefined;
  if (agent === "claude" || agent === "claude-free") return `claude --resume ${sessionId}`;
  if (agent === "codex" || agent === "codex-free") return `codex resume ${sessionId}`;
  if (agent === "cursor") return `agent --resume ${sessionId}`;
  return undefined;
}

/** A project folder and an IDE folder are the same, or one contains the other. */
function related(a: string, b: string): boolean {
  if (samePath(a, b)) return true;
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  return inside(a, b) || inside(b, a);
}
