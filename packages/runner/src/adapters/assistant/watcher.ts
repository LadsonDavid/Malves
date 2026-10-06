import type { Task } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";

/**
 * Malves keeps an eye on things while you're away: when a task finishes or
 * fails it tells you, as a notification that opens the task. Questions already
 * notify on their own (they stop the task if unanswered, so they ignore quiet
 * hours); these don't, so they wait out quiet hours.
 */
export type WatcherDeps = {
  subscribe: (listener: (event: LoggedEvent) => void) => () => void;
  task: (id: string) => Task | undefined;
  label: (agent: string) => string;
  notify: (title: string, message: string, click: string) => void;
  /** e.g. "22-7": no task notifications from 22:00 to 07:00, phone's local time = computer's. */
  quietHours?: string | undefined;
  now?: () => Date;
};

export function startWatcher(d: WatcherDeps): () => void {
  const now = d.now ?? (() => new Date());
  return d.subscribe((event) => {
    if (event.type !== "task.updated") return;
    const { task_id, state, reason } = event.data;
    if (state !== "done" && state !== "failed") return;
    if (isQuiet(d.quietHours, now())) return;
    const task = d.task(task_id);
    if (!task) return;
    const who = d.label(task.agent);
    const what = task.prompt.length > 80 ? `${task.prompt.slice(0, 80)}…` : task.prompt;
    d.notify(
      state === "done" ? `${who} finished` : `${who} couldn't finish`,
      state === "done" ? what : `${what}${reason ? `: ${reason}` : ""}`,
      `malves://task/${encodeURIComponent(task_id)}`,
    );
  });
}

/** Whether `date` falls in quiet hours like "22-7" (overnight) or "13-14". */
export function isQuiet(spec: string | undefined, date: Date): boolean {
  const match = spec?.match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!match) return false;
  const from = Number(match[1]) % 24;
  const to = Number(match[2]) % 24;
  const hour = date.getHours();
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
