import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Command, command } from "@malves/core";

const require = createRequire(import.meta.url);

/** How the runner starts one agent, and what to tell the user about it. */
export type AgentProfile = {
  /** The name people see, e.g. "Claude". */
  label: string;
  command: Command;
  /** Extra environment for this agent only. */
  env?: Record<string, string>;
  /**
   * The ACP sign-in method to choose explicitly after `initialize`. Only ever an
   * API-key method — never a personal-login one (see CLAUDE.md, Antigravity).
   */
  authMethod?: string;
  /** An environment variable the agent can't work without, e.g. its API key. */
  requiresEnv?: string;
  /** Allowance for starting up during a readiness check. */
  startupMs?: number;
  /** What to do when it needs signing in, in plain words. */
  signInHint: string;
  /** Set when the program isn't installed: what to do about it. */
  missing?: string;
  /**
   * Its model calls go through the budget guard to freellmapi (§6), so they are
   * metered. The value is the API format it speaks.
   */
  metered?: "anthropic" | "openai";
};

/**
 * Agents the runner knows how to start. Adapter packages are pinned
 * dependencies of the runner, so an update is a deliberate change to
 * package.json, not a download at run time. Each is started as `node <its
 * script>` or a real executable, never through `npx`: on Windows `npx` is
 * `npx.cmd`, which can't be started without a shell (§8).
 *
 * The runner never handles agents' credentials; each signs in on its own, or
 * reads its API key from the environment.
 */
export function agentProfiles(home = malvesHome()): Map<string, AgentProfile> {
  const demo = fileURLToPath(new URL("./demo-agent.js", import.meta.url));
  return new Map<string, AgentProfile>([
    ["demo", { label: "Demo", command: command(process.execPath, [demo]), signInHint: "" }],
    [
      "claude",
      {
        label: "Claude",
        command: node(installedBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")),
        signInHint: "On the computer, run `claude` in a terminal and type /login.",
      },
    ],
    [
      "codex",
      {
        label: "Codex",
        command: node(installedBin("@agentclientprotocol/codex-acp", "codex-acp")),
        signInHint: "On the computer, sign in to Codex (run `codex login`).",
      },
    ],
    ["antigravity", antigravity(home)],
    ...freeModels(),
  ]);
}

/**
 * Claude Code and Codex on your own free-tier keys: their model calls go to
 * freellmapi through the budget guard instead of to Anthropic or OpenAI.
 * Offered only once MALVES_MODELS_URL points at a freellmapi server.
 */
const FREE_HINT =
  "Put your freellmapi unified key in MALVES_MODELS_KEY (the project's .env), then start malves with --env-file=.env.";

function freeModels(): Array<[string, AgentProfile]> {
  if (!process.env.MALVES_MODELS_URL) return [];
  return [
    [
      "claude-free",
      {
        label: "Claude (free models)",
        command: node(installedBin("@agentclientprotocol/claude-agent-acp", "claude-agent-acp")),
        requiresEnv: "MALVES_MODELS_KEY",
        metered: "anthropic",
        signInHint: FREE_HINT,
      },
    ],
    [
      "codex-free",
      {
        label: "Codex (free models)",
        command: node(installedBin("@agentclientprotocol/codex-acp", "codex-acp")),
        // Always the API-key method: never the person's ChatGPT login.
        authMethod: "api-key",
        env: { NO_BROWSER: "1" },
        requiresEnv: "MALVES_MODELS_KEY",
        metered: "openai",
        signInHint: FREE_HINT,
      },
    ],
  ];
}

/**
 * Google's official ACP server for Antigravity (closed source, not bundled):
 * installed under the data folder, given its own GEMINI_HOME so it can never
 * see or use the person's Google login, and always signed in with a Gemini API
 * key. Driving Antigravity through a personal Google login got accounts banned
 * in Feb 2026.
 */
function antigravity(home: string): AgentProfile {
  const dir = path.join(home, "agents", "antigravity");
  const windows = process.platform === "win32";
  const program = path.join(dir, windows ? "agy_acp_server.exe" : "agy_acp_server.par");
  return {
    label: "Antigravity",
    command: command(program, process.platform === "linux" ? ["--uid="] : []),
    env: { GEMINI_HOME: path.join(dir, "home") },
    authMethod: "gemini-api-key",
    requiresEnv: "GEMINI_API_KEY",
    // Measured: ~30 s to answer `initialize` on Windows.
    startupMs: 120_000,
    signInHint:
      "Put your Gemini API key in GEMINI_API_KEY (the project's .env), then start malves with --env-file=.env.",
    ...(existsSync(program)
      ? {}
      : { missing: `Google's Antigravity ACP server isn't installed in ${dir}.` }),
  };
}

/** Agent name → how to start it, for the core. */
export function knownAgents(home?: string): Map<string, Command> {
  return new Map([...agentProfiles(home)].map(([name, p]) => [name, p.command]));
}

/** The name people see, e.g. "Claude". */
export function agentLabel(name: string, profiles = agentProfiles()): string {
  return profiles.get(name)?.label ?? name;
}

/** What to do when an agent needs signing in, in plain words. */
export function signInHint(name: string, profiles = agentProfiles()): string {
  return (
    profiles.get(name)?.signInHint ||
    `On the computer, open ${agentLabel(name, profiles)} and sign in.`
  );
}

export function signInMessage(name: string, profiles = agentProfiles()): string {
  return `${agentLabel(name, profiles)} isn't signed in on your computer. ${signInHint(name, profiles)} Then try again.`;
}

/** The data folder, without creating it. */
function malvesHome(): string {
  return process.env.MALVES_HOME ?? path.join(homedir(), ".malves");
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
