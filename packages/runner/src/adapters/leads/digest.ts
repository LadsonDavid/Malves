import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LeadSource } from "./signalstack.js";

/**
 * The weekly leads digest (R7): every Monday from 9:00, one notification with
 * counts only — "12 companies to contact this week: 3 hot, 5 warm". No names:
 * notifications show on the lock screen. If the lead engine is down it tries
 * again the next hour; it never sends twice in one week.
 */
export type DigestOptions = {
  leads: LeadSource;
  notify(title: string, message: string): void;
  /** Where the last sending time is kept. */
  dir: string;
  now?: () => Date;
  everyMs?: number;
};

export function startDigest(o: DigestOptions): () => void {
  const file = path.join(o.dir, "digest.json");
  const now = o.now ?? (() => new Date());
  const check = async () => {
    const due = lastMonday9(now());
    if (now() < due || lastSent(file) >= due.getTime()) return;
    try {
      const leads = await o.leads.fetch();
      const hot = leads.filter((l) => l.tier === "hot").length;
      const warm = leads.filter((l) => l.tier === "warm").length;
      o.notify(
        "This week's leads",
        leads.length === 0
          ? "No new companies to contact this week."
          : `${leads.length} compan${leads.length === 1 ? "y" : "ies"} to contact this week: ${hot} hot, ${warm} warm. Open Leads in malves.`,
      );
      writeFileSync(file, JSON.stringify({ sent: now().getTime() }));
    } catch {
      // The lead engine is down: try again at the next check.
    }
  };
  void check();
  const timer = setInterval(() => void check(), o.everyMs ?? 60 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** The most recent Monday 9:00 (local time) at or before `now`. */
export function lastMonday9(now: Date): Date {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

function lastSent(file: string): number {
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { sent: number }).sent;
  } catch {
    return 0;
  }
}
