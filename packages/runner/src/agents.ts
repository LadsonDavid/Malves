import { fileURLToPath } from "node:url";
import { type Command, command } from "@malves/core";

/**
 * Agents the runner knows how to start. Versions are pinned so an update to an
 * adapter package is a deliberate change here, not a surprise at run time.
 *
 * Claude Code and Codex need their own login or API key; the runner never
 * handles those credentials.
 */
export function knownAgents(): Map<string, Command> {
  const demo = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  return new Map([
    ["demo", command(process.execPath, [demo])],
    ["claude", command("npx", ["--yes", "@agentclientprotocol/claude-agent-acp@0.82.0"])],
    ["codex", command("npx", ["--yes", "@agentclientprotocol/codex-acp@2.0.0"])],
  ]);
}
