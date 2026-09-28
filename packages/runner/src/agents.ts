import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, command } from "@malves/core";

export type AgentSpec = {
  name: string;
  label: string;
  command: Command;
  /** Program that must be on PATH for this agent to be offered. */
  requires: string;
  /** Environment variables filled from the keychain (`malves secret set NAME`). */
  secretEnv?: string[];
  /** ACP auth method to use when the agent asks for one. */
  authMethod?: string;
};

/**
 * Agents the runner knows how to start (R5). Versions are pinned so an adapter
 * update is a deliberate change here, not a surprise at run time. The runner
 * never handles the agents' own logins; API keys, where needed, come from the
 * keychain.
 */
export function agentCatalog(): AgentSpec[] {
  const demo = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  const cursor = onPath("cursor-agent") ? "cursor-agent" : "agent";
  return [
    {
      name: "demo",
      label: "Demo agent (no model, for trying malves)",
      command: command(process.execPath, [demo]),
      requires: process.execPath,
    },
    {
      name: "claude",
      label: "Claude Code",
      command: command("npx", ["--yes", "@agentclientprotocol/claude-agent-acp@0.82.0"]),
      requires: "npx",
    },
    {
      name: "codex",
      label: "Codex",
      command: command("npx", ["--yes", "@agentclientprotocol/codex-acp@2.0.0"]),
      requires: "npx",
    },
    {
      // Cursor's own CLI speaks ACP (`agent acp`) and sends permission requests.
      name: "cursor",
      label: "Cursor",
      command: command(cursor, ["acp"]),
      requires: cursor,
      secretEnv: ["CURSOR_API_KEY"],
      authMethod: "cursor_login",
    },
    {
      // Community ACP adapter around Google's `agy` CLI. API key only — never a
      // consumer Google login. --no-skip-permissions is essential: without it
      // the adapter approves every tool call itself and nothing reaches the phone.
      name: "antigravity",
      label: "Antigravity",
      command: command("npx", ["--yes", "google-antigravity-acp@2.0.1", "--no-skip-permissions"]),
      requires: "npx",
      secretEnv: ["GEMINI_API_KEY"],
    },
  ];
}

export function commandMap(specs: AgentSpec[]): Map<string, Command> {
  return new Map(specs.map((s) => [s.name, s.command]));
}

/** Whether a program can be found (an absolute path, or on PATH). */
export function onPath(program: string): boolean {
  if (path.isAbsolute(program)) return executable(program);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      if (dir && executable(path.join(dir, program + ext))) return true;
    }
  }
  return false;
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
