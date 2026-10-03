import { tmpdir } from "node:os";
import path from "node:path";
import { type Core, createCore, type Notifier } from "@malves/core";
import type { AgentSessionInfo } from "@malves/protocol";
import { AcpHost, type Launch } from "./adapters/acp/host.js";
import { type BrowserTools, TOOL_SERVER_NAME } from "./adapters/browser/tools.js";
import type { BudgetGuard } from "./adapters/budget/guard.js";
import { GitChanges } from "./adapters/git/changes.js";
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
  /** Also notifies through this (`malves serve` with Tailscale). */
  usePush(push: Notifier): void;
  /** A finished task's changes as a diff, for "View changes". */
  diff(taskId: string): string;
  /** Meters free-model agents through this guard (§6). */
  useGuard(guard: BudgetGuard): void;
  /** The agent's saved conversations in a workspace, newest first, to continue one. */
  listSessions(agent: string, workspaceId: string): Promise<AgentSessionInfo[]>;
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
    let push: Notifier | undefined;
    let guard: BudgetGuard | undefined;
    const host = new AcpHost({
      ...(o.onActivity ? { onActivity: o.onActivity } : {}),
      onSignInNeeded: (agent) => status?.set(agent, "needs_sign_in"),
      onReady: (agent) => status?.set(agent, "ready"),
      signInMessage: (agent) => signInMessage(agent, profiles),
      launch: (agent, run) => {
        const profile = profiles.get(agent);
        return launchOf(profile, run && guard ? guard.urlFor(run.taskId) : undefined);
      },
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
      notifier: {
        async questionOpened(question) {
          await Promise.all([
            (o.notifier ?? noPush).questionOpened(question),
            push?.questionOpened(question),
          ]);
        },
      },
      host,
      agents,
      questionTimeoutMs: o.questionTimeoutMs,
    });
    const changes = new GitChanges(core, { questionTimeoutMs: o.questionTimeoutMs });
    const opened = store;
    return {
      ...core,
      agents: status,
      useBrowserTools(tools) {
        browserTools = tools;
      },
      usePush(notifier) {
        push = notifier;
      },
      useGuard(g) {
        guard = g;
      },
      diff: (taskId) => changes.diff(taskId),
      async listSessions(agent, workspaceId) {
        const profile = profiles.get(agent);
        if (!profile) throw new Error(`Unknown agent: ${agent}`);
        if (profile.missing) throw new Error(profile.missing);
        const workspace = core.workspaces.get(workspaceId);
        if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
        const found = await host.listSessions(
          agent,
          profile.command,
          workspace.path,
          launchOf(profile),
          profile.startupMs,
        );
        // ponytail: newest 20 only; add paging if people want older ones.
        return found.slice(0, 20).map((s) => ({
          id: s.sessionId,
          ...(s.title ? { title: s.title.slice(0, 200) } : {}),
          ...(s.updatedAt ? { updated_at: s.updatedAt } : {}),
        }));
      },
      close() {
        changes.close();
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

/**
 * Points a metered agent at the budget guard. Nothing listens on port 9, so
 * without the guard it can't reach any model. The key is a placeholder: the
 * guard adds the real freellmapi key, which the agent never sees.
 */
function meteredEnv(api: "anthropic" | "openai", guardUrl = "http://127.0.0.1:9") {
  const placeholder = "malves-budget-guard";
  if (api === "anthropic") {
    return { ANTHROPIC_BASE_URL: guardUrl, ANTHROPIC_AUTH_TOKEN: placeholder };
  }
  // Codex: its own provider, so neither OpenAI nor a ChatGPT login is ever used.
  const provider = {
    name: "malves",
    base_url: `${guardUrl}/v1`,
    wire_api: "responses",
    env_key: "CODEX_API_KEY",
  };
  return {
    CODEX_API_KEY: placeholder,
    MODEL_PROVIDER: "malves",
    CODEX_CONFIG: JSON.stringify({ model: "auto", model_providers: { malves: provider } }),
  };
}

/** `guardUrl`: where a metered agent's model calls go for this task. */
function launchOf(profile: AgentProfile | undefined, guardUrl?: string): Launch {
  if (!profile) return {};
  const env = profile.metered
    ? { ...profile.env, ...meteredEnv(profile.metered, guardUrl) }
    : profile.env;
  return {
    ...(env ? { env } : {}),
    ...(profile.authMethod ? { authMethod: profile.authMethod } : {}),
    ...(profile.requiresEnv ? { requiresEnv: profile.requiresEnv } : {}),
  };
}
