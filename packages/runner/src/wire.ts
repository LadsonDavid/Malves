import { tmpdir } from "node:os";
import path from "node:path";
import { type Core, createCore, type Notifier } from "@malves/core";
import { AcpHost, type Launch } from "./adapters/acp/host.js";
import { type BrowserTools, TOOL_SERVER_NAME } from "./adapters/browser/tools.js";
import { SqliteStore } from "./adapters/sqlite/store.js";
import { noPush } from "./adapters/terminal/terminal.js";
import { AgentStatus } from "./agent-status.js";
import { type AgentProfile, agentProfiles, signInMessage } from "./agents.js";
import { acquireLock, randomIds, systemClock } from "./system.js";

export type RunnerOptions = {
  dir: string;
  questionTimeoutMs: number;
  notifier?: Notifier;
  onActivity?: (taskId: string, text: string) => void;
};

export type Runner = Core & {
  agents: AgentStatus;
  /** Gives every task's agent these browser tools (`malves serve` only). */
  useBrowserTools(tools: BrowserTools): void;
  close(): void;
};

/** The one place where the core and the adapters are wired together (§3). */
export function openRunner(o: RunnerOptions): Runner {
  const release = acquireLock(o.dir);
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path.join(o.dir, "malves.db"));
    const profiles = agentProfiles(o.dir);
    const agents = new Map([...profiles].map(([name, p]) => [name, p.command]));
    // Real tasks keep the readiness labels honest between checks.
    let status: AgentStatus | undefined;
    let browserTools: BrowserTools | undefined;
    const host = new AcpHost({
      ...(o.onActivity ? { onActivity: o.onActivity } : {}),
      onSignInNeeded: (agent) => status?.set(agent, "needs_sign_in"),
      onReady: (agent) => status?.set(agent, "ready"),
      signInMessage: (agent) => signInMessage(agent, profiles),
      launch: (agent) => launchOf(profiles.get(agent)),
      toolServers: (run) => browserTools?.serversFor(run.taskId) ?? [],
      // ponytail: matched by name in the tool call, since agents describe MCP
      // calls differently; tighten if an agent's tool-call shape is documented.
      gatedElsewhere: (toolCall) => JSON.stringify(toolCall ?? "").includes(TOOL_SERVER_NAME),
    });
    status = new AgentStatus(profiles, (_name, p) =>
      host.probe(p.command, tmpdir(), launchOf(p), p.startupMs),
    );
    const core = createCore({
      store,
      clock: systemClock,
      ids: randomIds,
      notifier: o.notifier ?? noPush,
      host,
      agents,
      questionTimeoutMs: o.questionTimeoutMs,
    });
    const opened = store;
    return {
      ...core,
      agents: status,
      useBrowserTools(tools) {
        browserTools = tools;
      },
      close() {
        host.killAll();
        opened.close();
        release();
      },
    };
  } catch (error) {
    store?.close();
    release();
    throw error;
  }
}

function launchOf(profile: AgentProfile | undefined): Launch {
  if (!profile) return {};
  return {
    ...(profile.env ? { env: profile.env } : {}),
    ...(profile.authMethod ? { authMethod: profile.authMethod } : {}),
    ...(profile.requiresEnv ? { requiresEnv: profile.requiresEnv } : {}),
  };
}
