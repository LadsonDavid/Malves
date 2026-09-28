import path from "node:path";
import { type Core, createCore, type Notifier } from "@malves/core";
import { AcpHost } from "./adapters/acp/host.js";
import { SqliteStore } from "./adapters/sqlite/store.js";
import { noPush } from "./adapters/terminal/terminal.js";
import { knownAgents } from "./agents.js";
import { acquireLock, randomIds, systemClock } from "./system.js";

export type RunnerOptions = {
  dir: string;
  questionTimeoutMs: number;
  notifier?: Notifier;
  onActivity?: (taskId: string, text: string) => void;
};

export type Runner = Core & { close(): void };

/** The one place where the core and the adapters are wired together (§3). */
export function openRunner(o: RunnerOptions): Runner {
  const release = acquireLock(o.dir);
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(path.join(o.dir, "malves.db"));
    const host = new AcpHost(o.onActivity ? { onActivity: o.onActivity } : {});
    const core = createCore({
      store,
      clock: systemClock,
      ids: randomIds,
      notifier: o.notifier ?? noPush,
      host,
      agents: knownAgents(),
      questionTimeoutMs: o.questionTimeoutMs,
    });
    const opened = store;
    return {
      ...core,
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
