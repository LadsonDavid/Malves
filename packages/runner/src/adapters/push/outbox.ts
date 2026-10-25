import { readFileSync, writeFileSync } from "node:fs";

/**
 * Notifications that were sent, kept for a day, so a phone that was asleep,
 * out of signal or restarting still gets them when it reconnects. The ntfy app
 * says where it left off with `?since=` (a message id, a time or "10m"), and
 * this answers it. Questions aren't kept here: they are replayed from the
 * event log, which is the truth (§4).
 */
export const TTL_MS = 24 * 3_600_000;
export const MAX_KEPT = 100;

export type Stored = { id: string; time: number; event: string } & Record<string, unknown>;

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

export class Outbox {
  private list: Stored[] = [];
  private readonly now: () => number;

  constructor(private readonly o: { file?: string; now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
    if (o.file) {
      try {
        const saved = JSON.parse(readFileSync(o.file, "utf8")) as Stored[];
        if (Array.isArray(saved)) this.list = saved.filter((m) => typeof m?.id === "string");
      } catch {
        // No file yet, or a damaged one: start empty.
      }
    }
    this.trim();
  }

  add(message: Stored): void {
    this.list.push(message);
    this.trim();
    if (this.o.file) writeFileSync(this.o.file, JSON.stringify(this.list));
  }

  /**
   * What a phone missed. `undefined` means a brand-new subscription: only live
   * messages from here on.
   */
  since(marker: string | undefined): Stored[] {
    this.trim();
    if (!marker) return [];
    if (marker === "all") return [...this.list];
    if (marker === "latest") return this.list.slice(-1);
    const nowSeconds = this.now() / 1000;
    const duration = marker.match(/^(\d+)([smhd])$/);
    if (duration) {
      const cutoff = nowSeconds - Number(duration[1]) * (UNITS[duration[2] as string] ?? 1);
      return this.list.filter((m) => m.time >= cutoff);
    }
    if (/^\d{9,}$/.test(marker)) return this.list.filter((m) => m.time > Number(marker));
    const at = this.list.findIndex((m) => m.id === marker);
    // An id no longer held: give everything kept; the phone drops repeats by id.
    return at === -1 ? [...this.list] : this.list.slice(at + 1);
  }

  private trim(): void {
    const cutoff = this.now() - TTL_MS;
    this.list = this.list.filter((m) => m.time * 1000 >= cutoff).slice(-MAX_KEPT);
  }
}
