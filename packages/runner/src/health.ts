import type { Check } from "@malves/protocol";

/**
 * The computer's latest setup check, kept so every phone can see it and hear
 * when it changes. Runtime state only: it is cheap to make again.
 */
export class Health {
  private checks: Check[] = [];
  private readonly listeners = new Set<(checks: Check[]) => void>();
  private running: Promise<Check[]> | undefined;

  constructor(private readonly check: () => Promise<Check[]>) {}

  list(): Check[] {
    return this.checks;
  }

  subscribe(listener: (checks: Check[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs the check again. Calls made while one is running share it. */
  run(): Promise<Check[]> {
    this.running ??= this.check()
      .then((checks) => {
        this.checks = checks;
        for (const listener of this.listeners) listener(checks);
        return checks;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
