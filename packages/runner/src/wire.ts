import { tmpdir } from "node:os";
import path from "node:path";
import { type Core, createCore, type Notifier } from "@malves/core";
import { AcpHost } from "./adapters/acp/host.js";
import { SqliteStore } from "./adapters/sqlite/store.js";
import { noPush } from "./adapters/terminal/terminal.js";
import { AgentStatus } from "./agent-status.js";
import { knownAgents, signInMessage } from "./agents.js";
import { acquireLock, randomIds, systemClock } from "./system.js";

export type RunnerOptions = {
  dir: string;
  questionTimeoutMs: number;
  notifier?: Notifier;
  onActivity?: (taskId: string, text: string) => void;
};

export type Runner = Core & { agents: AgentStatus; close(): void };

/** The one place where the core and the adapters are wired together (§3). */
export function openRunner(o: RunnerOptions): Runner {
  const release = acquireLock(o.dir);
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path.join(o.dir, "malves.db"));
    const agents = knownAgents();
    // Real tasks keep the readiness labels honest between checks.
    let status: AgentStatus | undefined;
    const host = new AcpHost({
      ...(o.onActivity ? { onActivity: o.onActivity } : {}),
      onSignInNeeded: (agent) => status?.set(agent, "needs_sign_in"),
      onReady: (agent) => status?.set(agent, "ready"),
      signInMessage,
    });
    status = new AgentStatus(agents, (command) => host.probe(command, tmpdir()));
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
