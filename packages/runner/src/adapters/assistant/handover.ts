import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
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
  | { active: false; reason?: string; paused?: boolean }
  | { active: true; since: number; until: number; paused?: boolean };

export type HandoverOptions = {
  initialPaused?: boolean;
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
  private generation = 0;
  private readonly commands = new Map<AbortController, Promise<string>>();
  command(command: string, cwd: string): Promise<string> {
    if (!this.current.active || this.current.paused)
      return Promise.resolve("No command started: handover is inactive or you have control.");
    const controller = new AbortController();
    const operation = runCommand(command, cwd, 5 * 60_000, controller.signal).finally(() =>
      this.commands.delete(controller),
    );
    this.commands.set(controller, operation);
    return operation;
  }
  async commandsIdle(): Promise<void> {
    await Promise.allSettled([...this.commands.values()]);
  }
  cancelCommands(): void {
    for (const controller of this.commands.keys()) controller.abort();
  }
  private observation:
    | { id: string; title: string; fingerprint: string; at: number; generation: number }
    | undefined;
  get revision(): number {
    return this.generation;
  }

  /** Explicit ownership, never inferred from mouse movement. Existing native apps may keep running. */
  control(take: boolean): void {
    if (take) for (const controller of this.commands.keys()) controller.abort();
    this.generation++;
    this.observation = undefined;
    this.current = { ...this.current, paused: take };
    this.o.onChange(this.current);
  }
  observe(title: string, fingerprint: string): string {
    if (!this.current.active || this.current.paused || !title)
      throw new Error("Handover must be active with an identified window.");
    const id = randomUUID();
    this.observation = { id, title, fingerprint, at: Date.now(), generation: this.generation };
    return id;
  }
  consumeObservation(id: string, title: string, fingerprint: string): boolean {
    const seen = this.observation;
    if (
      !this.current.active ||
      this.current.paused ||
      !seen ||
      seen.id !== id ||
      seen.title !== title ||
      seen.fingerprint !== fingerprint ||
      seen.generation !== this.generation ||
      Date.now() - seen.at > 30_000
    )
      return false;
    this.observation = undefined;
    return true;
  }

  constructor(private readonly o: HandoverOptions) {
    if (o.initialPaused)
      this.current = {
        active: false,
        paused: true,
        reason: "Human control restored after restart.",
      };
  }

  get state(): HandoverState {
    return this.current;
  }

  start(): HandoverState {
    if (this.current.paused) return this.current;
    if (this.current.active) return this.current;
    const since = Date.now();
    this.generation++;
    this.observation = undefined;
    this.current = { active: true, since, until: since + (this.o.maxMs ?? FOUR_HOURS) };
    this.loading = this.o.desktop?.().catch(() => undefined);
    this.timer = setInterval(() => void this.check(), this.o.pollMs ?? 30_000);
    this.timer.unref();
    this.o.onChange(this.current);
    return this.current;
  }

  stop(reason: string): void {
    if (!this.current.active) return;
    for (const controller of this.commands.keys()) controller.abort();
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.observation = undefined;
    this.current = { active: false, reason, ...(this.current.paused ? { paused: true } : {}) };
    this.o.onChange(this.current);
  }

  /** The desktop, while handover is on and it loaded (Windows, nut.js). */
  async desktop(): Promise<Desktop | undefined> {
    return this.current.active && !this.current.paused ? await this.loading : undefined;
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
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs = 5 * 60_000,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return Promise.resolve("No command started: control changed.");
  const windows = process.platform === "win32";
  return new Promise((resolve) => {
    // powershell.exe / sh are real programs; the command is his, approved by the rules above.
    const child = spawn(
      windows ? "powershell.exe" : "sh",
      windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
      { cwd, windowsHide: true, env: process.env, detached: !windows },
    );
    let out = "";
    let interrupted = false;
    const kill = () => {
      interrupted = true;
      if (!child.pid) return;
      if (windows) {
        const killer = spawn(
          path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false },
        );
        killer.once("error", () => child.kill());
        killer.once("exit", (code) => {
          if (code !== 0) child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    const add = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(kill, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve(`Couldn't run it: ${error.message}`);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      const tail = out.trim().slice(-3000);
      resolve(
        `${interrupted ? "Command stopped; effects may be partial. Inspect before retrying." : `Exit code ${code}.`}\n${tail || "(no output)"}`,
      );
    });
  });
}
