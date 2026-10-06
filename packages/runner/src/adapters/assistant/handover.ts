import { spawn } from "node:child_process";

/**
 * Handover mode: "I'm leaving, take over." While it's on, Malves may run
 * commands in your project folders and use Chrome through the extension, on
 * top of what it always does. Tests and builds run by themselves; anything
 * else that changes something is read back to your phone and waits for yes.
 *
 * It ends when you press Stop (phone), say you're back, unlock the computer
 * after it was locked, or after four hours, whichever comes first.
 */
export type HandoverState =
  | { active: false; reason?: string }
  | { active: true; since: number; until: number };

export type HandoverOptions = {
  onChange: (state: HandoverState) => void;
  /** Whether the computer shows its lock screen; undefined where that can't be told. */
  locked?: (() => Promise<boolean>) | undefined;
  maxMs?: number;
  pollMs?: number;
};

const FOUR_HOURS = 4 * 60 * 60_000;

export class Handover {
  private current: HandoverState = { active: false };
  private timer: NodeJS.Timeout | undefined;
  private wasLocked = false;

  constructor(private readonly o: HandoverOptions) {}

  get state(): HandoverState {
    return this.current;
  }

  start(): HandoverState {
    if (this.current.active) return this.current;
    const since = Date.now();
    this.current = { active: true, since, until: since + (this.o.maxMs ?? FOUR_HOURS) };
    this.wasLocked = false;
    this.timer = setInterval(() => void this.check(), this.o.pollMs ?? 20_000);
    this.timer.unref();
    this.o.onChange(this.current);
    return this.current;
  }

  stop(reason: string): void {
    if (!this.current.active) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.current = { active: false, reason };
    this.o.onChange(this.current);
  }

  /** Time's up, or he came back: locked while away, unlocked now. */
  async check(): Promise<void> {
    if (!this.current.active) return;
    if (Date.now() >= this.current.until) return this.stop("Four hours are up.");
    const locked = await this.o.locked?.().catch(() => undefined);
    if (locked === undefined) return;
    if (locked) this.wasLocked = true;
    else if (this.wasLocked) this.stop("You're back at the computer.");
  }
}

/** Windows shows LogonUI.exe while the lock screen is up. */
export function windowsLocked(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("tasklist.exe", ["/FI", "IMAGENAME eq LogonUI.exe", "/NH"], {
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", () => resolve(/logonui\.exe/i.test(out)));
  });
}

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * How risky a command is. "look": only reads. "low": tests, builds, lint
 * (runs by itself in handover). "ask": anything else, or anything chained,
 * piped, redirected or using variables, which the rules can't see through.
 */
export function commandRisk(command: string): "look" | "low" | "ask" {
  const c = command.trim();
  if (!c || /[;&|><`$\r\n]/.test(c)) return "ask";
  if (
    /^(git (status|log|diff|show|branch|remote -v)\b|ls\b|dir\b|pwd$|cat\s|type\s|get-childitem\b|get-content\s|rg\s|findstr\s|where(\.exe)?\s|node (-v|--version)$|(pnpm|npm|yarn) (-v|--version|ls|list|outdated)\b)/i.test(
      c,
    )
  ) {
    return "look";
  }
  if (
    /^((pnpm|npm|yarn)( run)? (test|lint|build|typecheck|check|format:check)\b|pnpm -s (test|lint|build|typecheck)\b|pytest\b|python -m pytest\b|cargo (test|build|check|clippy)\b|go (test|build|vet)\b|dotnet (test|build)\b|mvn (test|verify)\b|gradle (test|build)\b)/i.test(
      c,
    )
  ) {
    return "low";
  }
  return "ask";
}

/** Runs one command in a project folder (PowerShell on Windows); output is cut to fit a reply. */
export function runCommand(command: string, cwd: string, timeoutMs = 5 * 60_000): Promise<string> {
  const windows = process.platform === "win32";
  return new Promise((resolve) => {
    // powershell.exe / sh are real programs; the command is his, approved by the rules above.
    const child = spawn(
      windows ? "powershell.exe" : "sh",
      windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
      { cwd, windowsHide: true, env: process.env },
    );
    let out = "";
    const add = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve(`Couldn't run it: ${error.message}`);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const tail = out.trim().slice(-3000);
      resolve(`Exit code ${code ?? "killed (took too long)"}.\n${tail || "(no output)"}`);
    });
  });
}
