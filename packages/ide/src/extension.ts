import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";

/**
 * malves' IDE companion (VS Code, Cursor, Antigravity, Windsurf — all VS Code
 * forks). It connects to `malves serve` on this computer and lets your phone:
 *  - start this IDE's own agent with a prompt (VS Code starts it; Cursor
 *    pre-fills it, and you press Enter at the desk);
 *  - open a task's changed files as diffs here;
 *  - reopen an agent conversation in this IDE's terminal.
 * Agent questions also appear here, so at your desk you answer them here.
 *
 * Only public extension APIs: no clicking the IDE's own buttons for it.
 */
const PORT = 7721;
const RETRY_MS = 5_000;
const MAX_FILES = 15;

type Call = { type: "call"; id: string; op: string; args: Record<string, unknown> };
type Question = {
  type: "question";
  question_id: string;
  agent: string;
  task: string;
  text: string;
  risk: "low" | "medium" | "high";
  choices: Array<{ id: string; label: string }>;
};

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = "malves.reconnect";
  status.show();
  let socket: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Questions already answered or closed: a late click does nothing. */
  const closed = new Set<string>();

  const show = (connected: boolean, detail: string) => {
    status.text = connected ? "$(plug) malves" : "$(debug-disconnect) malves";
    status.tooltip = detail;
  };

  const send = (message: object) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  const connect = () => {
    clearTimeout(retry);
    const token = readToken();
    if (!token) {
      show(false, "malves isn't set up on this computer yet: run `pnpm malves serve` once.");
      retry = setTimeout(connect, RETRY_MS * 6);
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    socket = ws;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({ type: "hello", token, app: vscode.env.appName, folders: folders() }),
      );
    });
    ws.on("message", (raw) => {
      let message: { type?: string } & Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.type === "ready") show(true, "Connected to malves on this computer.");
      else if (message.type === "call") void run(message as unknown as Call);
      else if (message.type === "question") void ask(message as unknown as Question);
      else if (message.type === "closed") closed.add(String(message.question_id));
    });
    ws.on("close", (code) => {
      if (socket !== ws) return;
      show(
        false,
        code === 4001
          ? "malves refused this IDE: its code changed. Run the reconnect command."
          : "malves isn't running on this computer (start `pnpm malves serve`).",
      );
      if (!stopped) retry = setTimeout(connect, RETRY_MS);
    });
    ws.on("error", () => {});
  };

  /** Does what the phone asked, and says what happened. */
  const run = async (call: Call) => {
    try {
      const message = await perform(call.op, call.args);
      send({ type: "result", id: call.id, ok: true, message });
    } catch (error) {
      send({
        type: "result",
        id: call.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** An agent's question, answerable here at the desk. */
  const ask = async (q: Question) => {
    const prompt = `malves — ${q.agent} asks: ${q.text}${q.task ? `  (task: ${q.task})` : ""}`;
    const pick =
      q.risk === "high"
        ? vscode.window.showWarningMessage(prompt, ...q.choices.map((c) => c.label))
        : vscode.window.showInformationMessage(prompt, ...q.choices.map((c) => c.label));
    const label = await pick;
    const choice = q.choices.find((c) => c.label === label);
    if (!choice || closed.has(q.question_id)) return;
    send({ type: "answer", question_id: q.question_id, choice_id: choice.id });
  };

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand("malves.reconnect", () => {
      socket?.terminate();
      connect();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      send({ type: "folders", folders: folders() }),
    ),
    {
      dispose: () => {
        stopped = true;
        clearTimeout(retry);
        socket?.terminate();
      },
    },
  );
  connect();
}

export function deactivate(): void {}

async function perform(op: string, args: Record<string, unknown>): Promise<string> {
  const app = vscode.env.appName;
  switch (op) {
    case "agent": {
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) throw new Error("Nothing to ask.");
      // Cursor: its documented deeplink pre-fills the agent chat; it never runs by itself.
      if (/cursor/i.test(app) || vscode.env.uriScheme === "cursor") {
        const url = `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt.slice(0, 2000))}`;
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return "Pre-filled in Cursor's agent chat. Press Enter at the computer to start it.";
      }
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes("workbench.action.chat.open")) {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: prompt,
          mode: "agent",
        });
        return `Started ${app}'s agent with your request. Its own approvals appear in ${app}.`;
      }
      throw new Error(
        `${app} doesn't let other programs start its agent. Use a malves task instead.`,
      );
    }
    case "open": {
      const root = String(args.root ?? "");
      const files = Array.isArray(args.files) ? args.files.map(String).slice(0, MAX_FILES) : [];
      for (const file of files) {
        const uri = vscode.Uri.file(path.join(root, file));
        try {
          await vscode.commands.executeCommand("git.openChange", uri);
        } catch {
          await vscode.commands.executeCommand("vscode.open", uri);
        }
      }
      const more =
        Array.isArray(args.files) && args.files.length > MAX_FILES ? " (the first 15)" : "";
      return `Opened ${files.length} changed file${files.length === 1 ? "" : "s"}${more} in ${app}.`;
    }
    case "terminal": {
      const command = String(args.command ?? "");
      // Only the resume commands malves builds itself; nothing else is ever typed.
      if (!/^(claude --resume|codex resume|agent --resume) [\w.:-]{1,128}$/.test(command)) {
        throw new Error("That isn't a command malves sends.");
      }
      const terminal = vscode.window.createTerminal({
        name: String(args.name ?? "malves"),
        cwd: String(args.cwd ?? ""),
      });
      terminal.show();
      terminal.sendText(command);
      return `Reopened the conversation in a terminal in ${app}.`;
    }
    default:
      throw new Error(`Unknown request: ${op}`);
  }
}

/** The secret `malves serve` keeps in its data folder; this IDE runs as the same user. */
function readToken(): string | undefined {
  const configured = vscode.workspace.getConfiguration("malves").get<string>("home");
  const home = configured || process.env.MALVES_HOME || path.join(homedir(), ".malves");
  try {
    const { token } = JSON.parse(readFileSync(path.join(home, "ide-token.json"), "utf8")) as {
      token?: unknown;
    };
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}
