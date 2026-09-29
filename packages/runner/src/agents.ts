import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, command } from "@malves/core";

const require = createRequire(import.meta.url);

/**
 * Agents the runner knows how to start. The adapter packages are pinned
 * dependencies of the runner, so an update is a deliberate change to
 * package.json, not a download at run time.
 *
 * Each one is started as `node <its script>`, never through `npx`: on Windows
 * `npx` is `npx.cmd`, which can't be started without a shell (§8).
 *
 * Claude Code and Codex need their own login or API key; the runner never
 * handles those credentials.
 */
export function knownAgents(): Map<string, Command> {
  const demo = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  return new Map([
    ["demo", command(process.execPath, [demo])],
    ["claude", node(installedBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp"))],
    ["codex", node(installedBin("@agentclientprotocol/codex-acp", "codex-acp"))],
  ]);
}

function node(script: string): Command {
  return command(process.execPath, [script]);
}

/** The absolute path of a script an installed package declares in its `bin`. */
function installedBin(pkg: string, name: string): string {
  const manifest = require.resolve(`${pkg}/package.json`);
  const { bin } = require(manifest) as { bin?: Record<string, string> };
  const relative = bin?.[name];
  if (!relative) throw new Error(`${pkg} has no "${name}" command`);
  return path.join(path.dirname(manifest), relative);
}
