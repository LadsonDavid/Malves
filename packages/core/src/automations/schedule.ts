/**
 * The schedule grammar (plan F2): small on purpose, not cron.
 *
 *   every 20m | every 2h | every 45s | every 1d
 *   daily 08:30 | weekdays 08:30 | weekends 10:00
 *   mon,wed,fri 09:00 | monday 09:00
 *
 * Clock times are local time.
 */
export type Schedule =
  | { kind: "every"; ms: number }
  | { kind: "at"; days: readonly number[]; minutes: number };

/** A monitor or schedule may not run more often than this: nobody wants a 1-second poll. */
export const MIN_EVERY_MS = 10_000;

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function parseSchedule(text: string): Schedule {
  const source = text.trim().toLowerCase();
  const every = /^every\s+(\d+)\s*([smhd])$/.exec(source);
  if (every) {
    const ms = Number(every[1]) * (UNIT_MS[every[2] ?? ""] ?? 0);
    if (ms < MIN_EVERY_MS) throw new Error(`"${text}" is too often. The shortest is every 10s.`);
    return { kind: "every", ms };
  }
  const at = /^(\S+)\s+(\d{1,2}):(\d{2})$/.exec(source);
  if (at) {
    const hours = Number(at[2]);
    const mins = Number(at[3]);
    if (hours > 23 || mins > 59) throw new Error(`"${text}" isn't a time of day.`);
    return { kind: "at", days: parseDays(at[1] ?? "", text), minutes: hours * 60 + mins };
  }
  throw new Error(
    `"${text}" isn't a schedule. Try "every 20m", "weekdays 08:30" or "mon,wed 09:00".`,
  );
}

function parseDays(word: string, original: string): number[] {
  if (word === "daily") return [0, 1, 2, 3, 4, 5, 6];
  if (word === "weekdays") return [1, 2, 3, 4, 5];
  if (word === "weekends") return [0, 6];
  const days = word.split(",").map((d) => {
    const short = DAYS.indexOf(d as (typeof DAYS)[number]);
    return short >= 0 ? short : DAY_NAMES[d];
  });
  if (days.length === 0 || days.some((d) => d === undefined)) {
    throw new Error(`"${original}" has a day I don't know. Use mon, tue, wed, thu, fri, sat, sun.`);
  }
  return [...new Set(days as number[])].sort();
}

/** The first moment strictly after `from` that the schedule is due. */
export function nextDue(schedule: Schedule, from: number): number {
  if (schedule.kind === "every") return from + schedule.ms;
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(from);
    day.setDate(day.getDate() + offset);
    day.setHours(Math.floor(schedule.minutes / 60), schedule.minutes % 60, 0, 0);
    if (schedule.days.includes(day.getDay()) && day.getTime() > from) return day.getTime();
  }
  // A schedule with at least one day always matches within a week.
  throw new Error("Schedule never comes due");
}
