import type { Desktop } from "./desktop.js";

export type BuildState = "idle" | "building" | "passed" | "failed";

export type PresenceState = {
  activeWindow: string;
  isIdle: boolean;
  idleSeconds: number;
  buildState: BuildState;
  timestamp: number;
};

export type PresenceOptions = {
  desktop?: Desktop | undefined;
  getBuildState?: (() => BuildState) | undefined;
  idleThresholdSeconds?: number | undefined;
};

/**
 * Stage 9: Presence signals without model calls (§9).
 * Monitors active window, idle state, and IDE build state efficiently.
 */
export class PresenceMonitor {
  private readonly desktop?: Desktop | undefined;
  private readonly getBuildState: () => BuildState;
  private readonly idleThresholdSeconds: number;
  private lastActivityTime = Date.now();

  constructor(options: PresenceOptions = {}) {
    this.desktop = options.desktop;
    this.getBuildState = options.getBuildState ?? (() => "idle");
    this.idleThresholdSeconds = options.idleThresholdSeconds ?? 120;
  }

  recordActivity(): void {
    this.lastActivityTime = Date.now();
  }

  async getPresence(): Promise<PresenceState> {
    let activeWindow = "Unknown";
    if (this.desktop) {
      try {
        activeWindow = await this.desktop.activeTitle();
      } catch {
        activeWindow = "Desktop";
      }
    }

    const idleSeconds = Math.floor((Date.now() - this.lastActivityTime) / 1000);
    const isIdle = idleSeconds >= this.idleThresholdSeconds;
    const buildState = this.getBuildState();

    return {
      activeWindow,
      isIdle,
      idleSeconds,
      buildState,
      timestamp: Date.now(),
    };
  }
}

export type BargeInOptions = {
  stopActiveStep: () => Promise<void>;
  speak?: ((message: string) => Promise<void> | void) | undefined;
};

/**
 * Stage 9: Barge-in handling (§9).
 * When wake word / barge-in occurs:
 * 1. Stops the running task step immediately.
 * 2. Optionally provides spoken feedback on PC speakers.
 */
export async function executeBargeIn(options: BargeInOptions): Promise<{ stopped: boolean; spoken: boolean }> {
  await options.stopActiveStep();
  let spoken = false;
  if (options.speak) {
    try {
      await options.speak("Stopped running step.");
      spoken = true;
    } catch {
      // Audio output non-fatal
    }
  }

  return { stopped: true, spoken };
}
