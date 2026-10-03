import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Lead } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import { lastMonday9, startDigest } from "../src/adapters/leads/digest.js";

/** The weekly leads digest: Monday from 9:00, counts only, once a week. */
const lead = (tier: Lead["tier"]) => ({ tier, name: "Secret Co" }) as Lead;

async function run(
  now: Date,
  leads: () => Promise<Lead[]>,
  dir = mkdtempSync(path.join(tmpdir(), "malves-digest-")),
) {
  const sent: string[] = [];
  const stop = startDigest({
    leads: { fetch: leads },
    dir,
    now: () => now,
    notify: (title, message) => sent.push(`${title}: ${message}`),
  });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  return { sent, dir };
}

describe("weekly leads digest", () => {
  it("finds the most recent Monday 9:00", () => {
    // Thu 8 Oct 2026 → Mon 5 Oct; Mon 5 Oct 08:00 → the Monday before.
    expect(lastMonday9(new Date(2026, 9, 8, 14)).toString()).toBe(
      new Date(2026, 9, 5, 9).toString(),
    );
    expect(lastMonday9(new Date(2026, 9, 5, 8)).toString()).toBe(
      new Date(2026, 8, 28, 9).toString(),
    );
    expect(lastMonday9(new Date(2026, 9, 5, 9)).toString()).toBe(
      new Date(2026, 9, 5, 9).toString(),
    );
  });

  it("sends counts only — never a company name — and only once a week", async () => {
    const monday = new Date(2026, 9, 5, 9, 30);
    const leads = async () => [lead("hot"), lead("warm"), lead("warm"), lead("cold")];
    const first = await run(monday, leads);
    expect(first.sent).toEqual([
      "This week's leads: 4 companies to contact this week: 1 hot, 2 warm. Open Leads in malves.",
    ]);
    expect(first.sent.join()).not.toContain("Secret Co");

    expect((await run(new Date(2026, 9, 8), leads, first.dir)).sent).toEqual([]); // same week
    expect((await run(new Date(2026, 9, 12, 9, 5), leads, first.dir)).sent).toHaveLength(1); // next Monday
  });

  it("tries again later when the lead engine is down", async () => {
    const monday = new Date(2026, 9, 5, 10);
    const down = await run(monday, async () => {
      throw new Error("down");
    });
    expect(down.sent).toEqual([]);
    expect((await run(monday, async () => [], down.dir)).sent).toEqual([
      "This week's leads: No new companies to contact this week.",
    ]);
  });
});
