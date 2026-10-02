import type { Command } from "@malves/core";
import type { AgentInfo, AgentState } from "@malves/protocol";
import type { Probe } from "./adapters/acp/host.js";
import { agentLabel, signInHint } from "./agents.js";

/**
 * Which agents can take a task right now, so the phone can say "needs sign-in"
 * before the user taps Start, not after the task fails.
 *
 * Known by asking each agent (`checkAll`), and kept current by what real tasks
 * reveal (`set`). Runtime state only — not logged.
 */
export class AgentStatus {
  private readonly info = new Map<string, AgentInfo>();
  private readonly listeners = new Set<(agents: AgentInfo[]) => void>();
  private checking: Promise<void> | undefined;

  constructor(
    private readonly agents: ReadonlyMap<string, Command>,
    private readonly probe: (command: Command) => Promise<Probe>,
  ) {
    for (const name of agents.keys()) {
      this.info.set(name, { name, label: agentLabel(name), state: "checking" });
    }
  }

  list(): AgentInfo[] {
    return [...this.info.values()];
  }

  subscribe(listener: (agents: AgentInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks every agent at once. Calls made while a check is running share it. */
  checkAll(): Promise<void> {
    if (this.checking) return this.checking;
    for (const name of this.agents.keys()) this.set(name, "checking");
    this.checking = Promise.all(
      [...this.agents].map(async ([name, command]) => {
        const result = await this.probe(command);
        this.set(name, result.state, result.detail);
      }),
    )
      .then(() => {})
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  /** Records what was learned, e.g. a task that failed because the agent isn't signed in. */
  set(name: string, state: AgentState, detail?: string): void {
    const current = this.info.get(name);
    if (!current) return;
    const hint =
      state === "needs_sign_in" ? signInHint(name) : state === "unavailable" ? detail : undefined;
    const next: AgentInfo = { name, label: current.label, state, ...(hint ? { hint } : {}) };
    if (current.state === next.state && current.hint === next.hint) return;
    this.info.set(name, next);
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }
}
