import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Task } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";
import { redact } from "../../redact.js";

/**
 * A plain-Markdown journal of what got done, in the Obsidian vault next to
 * Malves' memory, so it can be read and edited like any note:
 *
 *   Journal/2026-10-25.md      one line per finished task
 *   Journal/Weeks/2026-W43.md  a short roll-up of each finished week
 *
 * Written by code, with no model involved and nothing sent anywhere. It must
 * never get in the way of a task, so every write failure is swallowed.
 */
export type JournalDeps = {
  vault: string;
  subscribe: (listener: (event: LoggedEvent) => void) => () => void;
  task: (id: string) => Task | undefined;
  workspaceName: (id: string) => string | undefined;
  label: (agent: string) => string;
  now?: () => Date;
};

const DONE = "✓";
const FAILED = "✗";
const STOPPED = "■";
const LINE = /^- \d\d:\d\d (✓|✗|■) \*\*(.+?)\*\* in \*(.+?)\*: (.*)$/;

export function startJournal(d: JournalDeps): () => void {
  const now = d.now ?? (() => new Date());
  const changed = new Map<string, number>();
  return d.subscribe((event) => {
    if (event.type === "task.changes") changed.set(event.data.task_id, event.data.files.length);
    if (event.type !== "task.updated") return;
    const { task_id, state, reason } = event.data;
    if (state !== "done" && state !== "failed" && state !== "stopped") return;
    const task = d.task(task_id);
    if (!task) return;
    try {
      const when = now();
      const what = oneLine(task.prompt);
      const files = changed.get(task_id) ?? 0;
      const tail =
        state === "done"
          ? files > 0
            ? ` (${files} file${files === 1 ? "" : "s"} changed)`
            : ""
          : state === "failed"
            ? `. Couldn't finish${reason ? `: ${oneLine(reason)}` : "."}`
            : ". Stopped.";
      const mark = state === "done" ? DONE : state === "failed" ? FAILED : STOPPED;
      const line = `- ${hhmm(when)} ${mark} **${d.label(task.agent)}** in *${d.workspaceName(task.workspaceId) ?? "a folder"}*: ${what}${tail}\n`;
      appendDay(d.vault, when, line);
      changed.delete(task_id);
    } catch {
      // A full disk or a locked file must not touch the task itself.
    }
  });
}

function appendDay(vault: string, when: Date, line: string): void {
  const dir = path.join(vault, "Journal");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ymd(when)}.md`);
  const fresh = !existsSync(file);
  if (fresh) writeFileSync(file, `# Journal ${ymd(when)}\n\n`, "utf8");
  writeFileSync(file, readFileSync(file, "utf8") + line, "utf8");
  // A new day is a good moment to sum up any week that has finished.
  if (fresh) rollUpWeeks(vault, when);
}

/**
 * Writes `Journal/Weeks/<week>.md` for every finished week that has daily
 * lines and no summary yet. Returns the weeks it wrote. Safe to run any time.
 */
export function rollUpWeeks(vault: string, now: Date): string[] {
  const dir = path.join(vault, "Journal");
  if (!existsSync(dir)) return [];
  const byWeek = new Map<string, string[]>();
  for (const name of readdirSync(dir)) {
    const day = name.match(/^(\d{4}-\d\d-\d\d)\.md$/)?.[1];
    if (!day) continue;
    const week = isoWeek(new Date(`${day}T12:00:00`));
    byWeek.set(week, [...(byWeek.get(week) ?? []), day]);
  }
  const current = isoWeek(now);
  const made: string[] = [];
  for (const [week, days] of [...byWeek].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(dir, "Weeks", `${week}.md`);
    if (week >= current || existsSync(target)) continue;
    const lines = days
      .sort()
      .flatMap((day) => readFileSync(path.join(dir, `${day}.md`), "utf8").split("\n"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, summarise(week, days.sort(), lines), "utf8");
    made.push(week);
  }
  return made;
}

function summarise(week: string, days: string[], lines: string[]): string {
  const marks = { [DONE]: 0, [FAILED]: 0, [STOPPED]: 0 } as Record<string, number>;
  const agents = new Map<string, number>();
  const projects = new Map<string, number>();
  let files = 0;
  let total = 0;
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m) continue;
    total += 1;
    marks[m[1] as string] = (marks[m[1] as string] ?? 0) + 1;
    agents.set(m[2] as string, (agents.get(m[2] as string) ?? 0) + 1);
    projects.set(m[3] as string, (projects.get(m[3] as string) ?? 0) + 1);
    files += Number(m[4]?.match(/\((\d+) files? changed\)/)?.[1] ?? 0);
  }
  const ranked = (counts: Map<string, number>) =>
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name} ${n}`)
      .join(", ");
  return [
    `# Week ${week}`,
    "",
    `${total} task${total === 1 ? "" : "s"}: ${marks[DONE]} finished, ${marks[FAILED]} couldn't finish, ${marks[STOPPED]} stopped.`,
    "",
    `By agent: ${ranked(agents) || "none"}`,
    `By project: ${ranked(projects) || "none"}`,
    `${files} files changed.`,
    "",
    `Days: ${days.join(", ")}`,
    "",
  ].join("\n");
}

/** ISO 8601 week, e.g. "2026-W43" (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: Date): string {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() + 3 - ((thursday.getDay() + 6) % 7));
  const jan1 = new Date(thursday.getFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - jan1.getTime()) / 86_400_000 / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

const two = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const hhmm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** One line, secrets hidden, at most 140 characters. */
function oneLine(text: string): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
}
