import type { AgentInfo, AgentState } from "@malves/protocol";
import type { Probe } from "./adapters/acp/host.js";
import type { AgentProfile } from "./agents.js";

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
    private readonly profiles: ReadonlyMap<string, AgentProfile>,
    private readonly probe: (name: string, profile: AgentProfile) => Promise<Probe>,
  ) {
    for (const [name, p] of profiles)
      this.info.set(name, {
        name,
        label: p.label,
        state: "checking",
        ...(p.metered ? { metered: true } : {}),
      });
  }

  list(): AgentInfo[] {
    return [...this.info.values()];
  }

  subscribe(listener: (agents: AgentInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Asks every agent, two at a time: starting all seven at once (at the
   * background serve's low priority) made slow starters miss their time limit.
   * Calls made while a check is running share it.
   */
  checkAll(): Promise<void> {
    if (this.checking) return this.checking;
    for (const name of this.profiles.keys()) this.set(name, "checking");
    const queue = [...this.profiles];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [name, profile] = next;
        // Not installed: say so, without trying to start it.
        if (profile.missing) {
          this.set(name, "unavailable", profile.missing);
          continue;
        }
        const result = await this.probe(name, profile);
        // Started but slow to answer: usable. A real task that fails still says why.
        if (result.slow) this.set(name, "ready", "Slow to start: give it a minute.");
        else this.set(name, result.state, result.detail);
      }
    };
    this.checking = Promise.all([worker(), worker()])
      .then(() => {})
      .finally(() => {
        this.checking = undefined;
      });
    return this.checking;
  }

  /** Records what was learned, e.g. a task that failed because the agent isn't signed in. */
  set(name: string, state: AgentState, detail?: string): void {
    const current = this.info.get(name);
    const profile = this.profiles.get(name);
    if (!current || !profile) return;
    const hint =
      state === "needs_sign_in"
        ? profile.signInHint || undefined
        : state === "checking"
          ? undefined
          : detail;
    const next: AgentInfo = {
      name,
      label: current.label,
      state,
      ...(hint ? { hint } : {}),
      ...(current.metered ? { metered: true } : {}),
    };
    if (current.state === next.state && current.hint === next.hint) return;
    this.info.set(name, next);
    const list = this.list();
    for (const listener of this.listeners) listener(list);
  }
}
