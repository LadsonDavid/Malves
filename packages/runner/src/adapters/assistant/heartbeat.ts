import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LoggedEvent } from "@malves/protocol";
import { isQuiet } from "./watcher.js";

/**
 * The heartbeat: every few minutes Malves looks at a short list of cheap rules
 * and speaks up only when one fires. No model is called, so it costs nothing
 * and can't be talked into anything by text it reads.
 *
 *  1. A running task that has gone quiet for a long time (stuck agents).
 *  2. His own reminders, written in the vault note "Heartbeat.md":
 *       - at 09:00 remind: Look at the open tasks
 *       - every 2h remind: Stand up and drink water
 *
 * What it already told him is remembered in heartbeat.json, so a restart does
 * not repeat it. Quiet hours (MALVES_QUIET_HOURS) hold everything back.
 */
export const HEARTBEAT_FILE = "Heartbeat.md";

const TEMPLATE = `# Heartbeat

Malves checks this list every few minutes and tells you when one is due. One line each:

- at 09:00 remind: Look at the open tasks
- every 2h remind: Stand up and drink water

(Delete the leading "- " of a line to switch it off. Lines that don't match are ignored.)
`;

export type HeartbeatDeps = {
  vault: string;
  dataDir: string;
  /** The event log, to see which tasks are still doing something. */
  subscribe: (listener: (event: LoggedEvent) => void) => () => void;
  running: () => Array<{ id: string; agent: string; prompt: string }>;
  label: (agent: string) => string;
  notify: (title: string, message: string, click: string) => void;
  quietHours?: string | undefined;
  now?: () => Date;
  /** How often to look; default five minutes. */
  intervalMs?: number;
  /** A running task silent this long is "stuck"; default 45 minutes. */
  stuckAfterMs?: number;
};

type State = { fired: Record<string, number> };
type Reminder = { key: string; text: string; at?: [number, number]; everyMs?: number };

const MINUTE = 60_000;

export class Heartbeat {
  private readonly lastSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly now: () => Date;

  constructor(private readonly d: HeartbeatDeps) {
    this.now = d.now ?? (() => new Date());
  }

  start(): () => void {
    this.seed();
    this.unsubscribe = this.d.subscribe((event) => {
      const id = (event.data as { task_id?: unknown } | undefined)?.task_id;
      if (typeof id === "string") this.lastSeen.set(id, this.now().getTime());
    });
    this.timer = setInterval(() => this.tick(), this.d.intervalMs ?? 5 * MINUTE);
    this.timer.unref();
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** One look at the rules. Returns what it said, for tests. */
  tick(): string[] {
    const said: string[] = [];
    const when = this.now();
    const quiet = isQuiet(this.d.quietHours, when);
    const state = this.load();
    const t = when.getTime();

    // 1. Quiet running tasks.
    const stuckAfter = this.d.stuckAfterMs ?? 45 * MINUTE;
    for (const task of this.d.running()) {
      const seen = this.lastSeen.get(task.id) ?? t;
      this.lastSeen.set(task.id, seen);
      const key = `stuck:${task.id}`;
      if (t - seen < stuckAfter || t - (state.fired[key] ?? 0) < 3 * 60 * MINUTE) continue;
      if (quiet) continue;
      state.fired[key] = t;
      const minutes = Math.round((t - seen) / MINUTE);
      const what = task.prompt.length > 70 ? `${task.prompt.slice(0, 70)}…` : task.prompt;
      const text = `${this.d.label(task.agent)} has been quiet for ${minutes} minutes on "${what}".`;
      this.d.notify("A task may be stuck", text, `malves://task/${encodeURIComponent(task.id)}`);
      said.push(text);
    }

    // 2. His reminders.
    for (const r of this.reminders()) {
      const last = state.fired[r.key];
      let due = false;
      if (r.at) {
        const start = new Date(when);
        start.setHours(r.at[0], r.at[1], 0, 0);
        const late = t - start.getTime();
        // Once a day, within three hours of its time (a laptop that was off misses it).
        due = late >= 0 && late < 180 * MINUTE && !(last !== undefined && last >= start.getTime());
      } else if (r.everyMs) {
        // The first look only starts the clock.
        if (last === undefined) state.fired[r.key] = t;
        else due = t - last >= r.everyMs;
      }
      if (!due || quiet) continue;
      state.fired[r.key] = t;
      this.d.notify("Reminder", r.text, "malves://home");
      said.push(r.text);
    }

    this.save(state);
    return said;
  }

  /** Writes the example note once, so the format is there to edit. */
  private seed(): void {
    const file = path.join(this.d.vault, HEARTBEAT_FILE);
    if (existsSync(file)) return;
    try {
      mkdirSync(this.d.vault, { recursive: true });
      writeFileSync(file, TEMPLATE, "utf8");
    } catch {
      // A read-only vault just has no reminders.
    }
  }

  private reminders(): Reminder[] {
    let text: string;
    try {
      text = readFileSync(path.join(this.d.vault, HEARTBEAT_FILE), "utf8");
    } catch {
      return [];
    }
    const out: Reminder[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(
        /^- (?:at (\d{1,2}):(\d{2})|every (\d{1,3})\s*(m|h)) remind:\s*(.+?)\s*$/i,
      );
      if (!m) continue;
      const body = (m[5] ?? "").slice(0, 200);
      if (m[1] !== undefined) {
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h < 24 && min < 60)
          out.push({ key: `at:${m[1]}:${m[2]}:${body}`, text: body, at: [h, min] });
      } else {
        const n = Number(m[3]);
        const everyMs = n * (m[4]?.toLowerCase() === "h" ? 60 : 1) * MINUTE;
        if (n > 0 && everyMs >= 5 * MINUTE)
          out.push({ key: `every:${n}${m[4]}:${body}`, text: body, everyMs });
      }
    }
    return out;
  }

  private load(): State {
    try {
      const data = JSON.parse(
        readFileSync(path.join(this.d.dataDir, "heartbeat.json"), "utf8"),
      ) as State;
      return { fired: data.fired ?? {} };
    } catch {
      return { fired: {} };
    }
  }

  private save(state: State): void {
    try {
      writeFileSync(path.join(this.d.dataDir, "heartbeat.json"), JSON.stringify(state), "utf8");
    } catch {
      // The heartbeat must never get in the way.
    }
  }
}
