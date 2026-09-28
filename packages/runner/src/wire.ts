import { hostname } from "node:os";
import path from "node:path";
import { type Core, createCore, type Notifier } from "@malves/core";
import type { AgentInfo } from "@malves/protocol";
import { AcpHost, type RunExtras } from "./adapters/acp/host.js";
import { type Secrets, secretsFor } from "./adapters/secrets/secrets.js";
import { SqliteStore } from "./adapters/sqlite/store.js";
import { noPush } from "./adapters/terminal/terminal.js";
import { type AgentSpec, agentCatalog, commandMap, onPath } from "./agents.js";
import { type Identity, loadIdentity } from "./identity.js";
import { acquireLock, randomIds, randomTokens, systemClock } from "./system.js";

export type RunnerOptions = {
  dir: string;
  questionTimeoutMs: number;
  secrets?: Secrets;
  notifier?: (core: () => Core) => Notifier;
  onActivity?: (taskId: string, text: string) => void;
  /** Extra per-run setup (browser gate, budget guard), merged in order. */
  extras?: Array<(run: import("@malves/core").AgentRun) => RunExtras | Promise<RunExtras>>;
  agents?: AgentSpec[];
};

export type Runner = Core & {
  dir: string;
  name: string;
  identity: Identity;
  secrets: Secrets;
  agents: AgentSpec[];
  agentInfo(): AgentInfo[];
  close(): void;
};

/** The one place where the core and the adapters are wired together (§3). */
export function openRunner(o: RunnerOptions): Runner {
  const release = acquireLock(o.dir);
  let store: SqliteStore | undefined;
  try {
    const secrets = o.secrets ?? secretsFor(o.dir);
    const identity = loadIdentity(secrets);
    const agents = o.agents ?? agentCatalog();
    const specs = new Map(agents.map((a) => [a.name, a]));
    store = new SqliteStore(path.join(o.dir, "malves.db"));

    const host = new AcpHost({
      ...(o.onActivity ? { onActivity: o.onActivity } : {}),
      prepare: async (run) => {
        const spec = specs.get(run.agent);
        const env: Record<string, string> = {};
        for (const name of spec?.secretEnv ?? []) {
          const value = secrets.get(name);
          if (value) env[name] = value;
        }
        let merged: RunExtras = {
          env,
          ...(spec?.authMethod ? { authMethod: spec.authMethod } : {}),
        };
        for (const extra of o.extras ?? []) {
          const more = await extra(run);
          merged = {
            ...merged,
            ...more,
            env: { ...merged.env, ...more.env },
            mcpServers: [...(merged.mcpServers ?? []), ...(more.mcpServers ?? [])],
          };
        }
        return merged;
      },
    });

    let core: Core | undefined;
    const notifier = o.notifier ? o.notifier(() => core as Core) : noPush;
    core = createCore({
      store,
      clock: systemClock,
      ids: randomIds,
      random: randomTokens,
      notifier,
      host,
      agents: commandMap(agents),
      questionTimeoutMs: o.questionTimeoutMs,
    });

    const opened = store;
    return {
      ...core,
      dir: o.dir,
      name: hostname(),
      identity,
      secrets,
      agents,
      agentInfo: () => agents.map((a) => ({ name: a.name, available: onPath(a.requires) })),
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
