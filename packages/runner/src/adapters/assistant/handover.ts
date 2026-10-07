import { spawn } from "node:child_process";
import type { Desktop } from "./desktop.js";

/**
 * Handover mode: "I'm leaving, take over." While it's on, Malves may run
 * commands in your project folders, use Chrome, and use the screen; tests and
 * builds run by themselves, anything else that changes something is read back
 * to your phone and waits for yes. The phone can watch the screen live.
 *
 * It ends only when you say so (Stop on the phone, or "I'm back") or after
 * four hours. Touching the computer doesn't end it: you may be at the desk,
 * watching it work.
 */
export type HandoverState =
  | { active: false; reason?: string }
  | { active: true; since: number; until: number };

export type HandoverOptions = {
  onChange: (state: HandoverState) => void;
  /** Mouse, keyboard and screen (loaded when handover starts). */
  desktop?: (() => Promise<Desktop>) | undefined;
  maxMs?: number;
  pollMs?: number;
};

const FOUR_HOURS = 4 * 60 * 60_000;

export class Handover {
  private current: HandoverState = { active: false };
  private timer: NodeJS.Timeout | undefined;
  private loading: Promise<Desktop | undefined> | undefined;

  constructor(private readonly o: HandoverOptions) {}

  get state(): HandoverState {
    return this.current;
  }

  start(): HandoverState {
    if (this.current.active) return this.current;
    const since = Date.now();
    this.current = { active: true, since, until: since + (this.o.maxMs ?? FOUR_HOURS) };
    this.loading = this.o.desktop?.().catch(() => undefined);
    this.timer = setInterval(() => void this.check(), this.o.pollMs ?? 30_000);
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

  /** The desktop, while handover is on and it loaded (Windows, nut.js). */
  async desktop(): Promise<Desktop | undefined> {
    return this.current.active ? await this.loading : undefined;
  }

  /** Four hours are up. */
  async check(): Promise<void> {
    if (this.current.active && Date.now() >= this.current.until) this.stop("Four hours are up.");
  }
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Files that hold secrets: never read without asking, even inside the project. */
const SECRET =
  /(^|[\\/])(\.env\b|[^\\/]*\.(key|pem|pfx|p12)$|id_[a-z0-9]+$|\.npmrc$|\.netrc$|[^\\/]*(secret|credential|token|password)[^\\/]*$|.*keys?\.txt$)/i;

/** A command argument that points outside the project (or at a secret). */
function outsideOrSecret(arg: string): boolean {
  return (
    /^([a-z]:|[\\/]|~)/i.test(arg) || // absolute or home: outside the project
    /(^|[\\/])\.\.([\\/]|$)/.test(arg) || // climbs out with ..
    SECRET.test(arg)
  );
}

/**
 * How risky a command is. "look": only reads, inside the project. "low":
 * tests, builds, lint (runs by itself in handover). "ask": anything else.
 *
 * Only plain words are judged: anything with brackets, quotes, variables,
 * chaining, pipes or redirection asks, because PowerShell and sh can hide a
 * second command in them (e.g. `git log (Remove-Item x)`).
 */
export function commandRisk(command: string): "look" | "low" | "ask" {
  const c = command.trim();
  if (!c || !/^[\w\s.\-/\\:=,+]+$/.test(c)) return "ask";
  const args = c.split(/\s+/).slice(1);
  if (args.some(outsideOrSecret)) return "ask";
  if (
    // git branch only lists: -D/-m/a new name would change things.
    /^(git (status|log|diff|show)\b(?!.*--output)|git branch( (-a|-r|-v|-vv|--list|--show-current))*$|git remote -v$|ls\b|dir\b|pwd$|cat\s|type\s|get-childitem\b|get-content\s|rg\s|findstr\s|node (-v|--version)$|(pnpm|npm|yarn) (-v|--version|ls|list|outdated)\b)/i.test(
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
