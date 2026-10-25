import path from "node:path";
import {
  type Alert,
  type Delivery,
  lineDiff,
  fingerprint,
  type MonitorRunner,
  type MonitorSnapshot,
  type MonitorState,
  MAX_PENDING,
  nextDue,
  parseSchedule,
} from "@malves/core";
import type { AutomationRule, MonitorSource } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import { flush, setup } from "./fakes.js";

// ── schedule grammar ─────────────────────────────────────────────────────

/** Local time, so these hold in any time zone. 2026-10-25 is a Sunday. */
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m, 0, 0).getTime();

describe("schedule grammar", () => {
  it("every N units", () => {
    expect(nextDue(parseSchedule("every 20m"), 0)).toBe(20 * 60_000);
    expect(nextDue(parseSchedule("every 2h"), 1000)).toBe(1000 + 2 * 3_600_000);
    expect(nextDue(parseSchedule("every 1d"), 0)).toBe(86_400_000);
    expect(nextDue(parseSchedule("every 10s"), 0)).toBe(10_000);
  });

  it("refuses anything faster than every 10 seconds", () => {
    expect(() => parseSchedule("every 5s")).toThrow(/too often/);
  });

  it("weekdays skip the weekend and are strictly after now", () => {
    const s = parseSchedule("weekdays 08:30");
    expect(nextDue(s, at(25, 12))).toBe(at(26, 8, 30)); // Sunday noon → Monday
    expect(nextDue(s, at(26, 7))).toBe(at(26, 8, 30)); // Monday early → same day
    expect(nextDue(s, at(26, 8, 30))).toBe(at(27, 8, 30)); // exactly due → tomorrow
    expect(nextDue(s, at(30, 9))).toBe(new Date(2026, 10, 2, 8, 30).getTime()); // Friday 09:00 → Monday
  });

  it("named days, daily and weekends", () => {
    expect(nextDue(parseSchedule("mon,wed 09:00"), at(26, 10))).toBe(at(28, 9));
    expect(nextDue(parseSchedule("monday 09:00"), at(26, 10))).toBe(new Date(2026, 10, 2, 9).getTime());
    expect(nextDue(parseSchedule("daily 06:15"), at(25, 7))).toBe(at(26, 6, 15));
    expect(nextDue(parseSchedule("weekends 10:00"), at(26, 9))).toBe(at(31, 10)); // Saturday
  });

  it("says plainly what is wrong", () => {
    expect(() => parseSchedule("garbage")).toThrow(/isn't a schedule/);
    expect(() => parseSchedule("weekdays 25:00")).toThrow(/time of day/);
    expect(() => parseSchedule("someday 09:00")).toThrow(/day I don't know/);
  });
});

describe("monitor text helpers", () => {
  it("the same text has the same fingerprint, a changed one doesn't", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("")).toHaveLength(16);
  });

  it("the diff shows what disappeared and what appeared, cut to the limit", () => {
    expect(lineDiff("a\nb", "b\nc", 100)).toBe("- a\n+ c");
    expect(lineDiff("x", "x", 100)).toBe("");
    expect(lineDiff("", "y".repeat(50), 10)).toHaveLength(10);
  });
});

// ── fakes ────────────────────────────────────────────────────────────────

class FakeMonitors implements MonitorRunner {
  reads = 0;
  output = "ok";
  failure: Error | undefined;
  last: MonitorSource | undefined;
  async read(source: MonitorSource): Promise<string> {
    this.reads++;
    this.last = source;
    if (this.failure) throw this.failure;
    return this.output;
  }
}

class MemoryState implements MonitorState {
  readonly saved = new Map<string, MonitorSnapshot>();
  get(id: string) {
    return this.saved.get(id);
  }
  set(id: string, snapshot: MonitorSnapshot) {
    this.saved.set(id, snapshot);
  }
  remove(id: string) {
    this.saved.delete(id);
  }
}

class RecordingDelivery implements Delivery {
  readonly sent: Alert[] = [];
  fail = false;
  async deliver(alert: Alert) {
    if (this.fail) throw new Error("ntfy is down");
    this.sent.push(alert);
  }
}

function world(minGapMs?: number) {
  const monitors = new FakeMonitors();
  const state = new MemoryState();
  const delivery = new RecordingDelivery();
  const c = setup({
    automations: { monitors, state, delivery, ...(minGapMs === undefined ? {} : { minGapMs }) },
  });
  const automations = c.automations;
  const suggestions = c.suggestions;
  if (!automations || !suggestions) throw new Error("automations are off");
  const ws = c.workspaces.register("proj", path.resolve("/work/proj"));
  return { ...c, automations, suggestions, monitors, state, delivery, ws };
}

/** Moves the fake clock in one-minute steps (the scheduler looks again at least that often). */
async function advanceBy(c: { clock: { advance(ms: number): void } }, ms: number) {
  for (let left = ms; left > 0; left -= 60_000) {
    c.clock.advance(Math.min(60_000, left));
    await flush();
    await flush();
  }
}

const notify = (name: string, trigger: AutomationRule["trigger"], over: Partial<AutomationRule> = {}): AutomationRule => ({
  name,
  trigger,
  action: { kind: "notify", template: `${name}: {{diff}}` },
  importance: "notification",
  enabled: true,
  ...over,
});

const fired = (c: { store: { events: Array<{ type: string }> } }) =>
  c.store.events.filter((e) => e.type === "automation.fired");

// ── automations ──────────────────────────────────────────────────────────

describe("automations: rules", () => {
  it("rejects a bad schedule before anything is written", () => {
    const w = world();
    expect(() => w.automations.create(notify("x", { kind: "schedule", schedule: "whenever" }))).toThrow(/isn't a schedule/);
    expect(() =>
      w.automations.create(
        notify("x", { kind: "monitor", every: "every 1s", source: { kind: "port", host: "h", port: 1 } }),
      ),
    ).toThrow(/too often/);
    expect(w.store.events.filter((e) => e.type.startsWith("automation"))).toEqual([]);
  });

  it("lives in the log: a new core over the same events has the same rules, changes and removals", () => {
    const w = world();
    const a = w.automations.create(notify("a", { kind: "schedule", schedule: "every 1h" }));
    const b = w.automations.create(notify("b", { kind: "schedule", schedule: "every 2h" }));
    w.automations.change(a.id, { enabled: false });
    w.automations.remove(b.id);
    const again = setup({
      store: w.store,
      automations: { monitors: new FakeMonitors(), state: new MemoryState(), delivery: new RecordingDelivery() },
    });
    expect(again.automations?.list().map((r) => [r.name, r.enabled])).toEqual([["a", false]]);
  });
});

describe("automations: schedules", () => {
  it("fires at its time, once per period, and delivers by importance", async () => {
    const w = world();
    w.automations.create(notify("tick", { kind: "schedule", schedule: "every 20m" }));
    w.automations.start();
    await advanceBy(w, 19 * 60_000);
    expect(fired(w)).toHaveLength(0);
    await advanceBy(w, 60_000);
    expect(fired(w)).toHaveLength(1);
    await advanceBy(w, 20 * 60_000);
    expect(fired(w)).toHaveLength(2);
    expect(w.delivery.sent.map((a) => a.importance)).toEqual(["notification", "notification"]);
    w.automations.stop();
  });

  it("log-only rules leave an event and tell nobody; a call is handed over as a call", async () => {
    const w = world();
    w.automations.create(notify("quiet", { kind: "schedule", schedule: "every 1m" }, { importance: "log" }));
    w.automations.create(notify("loud", { kind: "schedule", schedule: "every 1m" }, { importance: "call" }));
    w.automations.start();
    await advanceBy(w, 60_000);
    expect(fired(w)).toHaveLength(2);
    expect(w.delivery.sent.map((a) => [a.name, a.importance])).toEqual([["loud", "call"]]);
    w.automations.stop();
  });

  it("a disabled rule never fires", async () => {
    const w = world();
    w.automations.create(notify("off", { kind: "schedule", schedule: "every 1m" }, { enabled: false }));
    w.automations.start();
    await advanceBy(w, 5 * 60_000);
    expect(fired(w)).toHaveLength(0);
    w.automations.stop();
  });

  it("a failing delivery is logged and does not stop the rule", async () => {
    const w = world();
    w.delivery.fail = true;
    w.automations.create(notify("tick", { kind: "schedule", schedule: "every 1m" }));
    w.automations.start();
    await advanceBy(w, 2 * 60_000);
    expect(fired(w).length).toBeGreaterThanOrEqual(2);
    expect(w.store.events.some((e) => e.type === "error" && e.data.code === "delivery_failed")).toBe(true);
    w.automations.stop();
  });
});

describe("automations: monitors hash before they think", () => {
  const rule = (over: Partial<AutomationRule> = {}) =>
    notify("ci", { kind: "monitor", every: "every 1m", source: { kind: "command", command: "gh run list", workspace_id: "ws1" } }, over);

  it("the first reading speaks, unchanged readings say nothing, one change speaks once with its diff", async () => {
    const w = world();
    w.automations.create(rule());
    w.automations.start();
    w.clock.advance(0);
    await flush();
    await flush();
    expect(w.delivery.sent).toHaveLength(1);
    expect(w.delivery.sent[0]?.text).toContain("ok");

    await advanceBy(w, 10 * 60_000);
    expect(w.monitors.reads).toBeGreaterThanOrEqual(10);
    expect(w.delivery.sent).toHaveLength(1);
    expect(fired(w)).toHaveLength(1);

    w.monitors.output = "ok\nbuild failed";
    await advanceBy(w, 60_000);
    expect(w.delivery.sent).toHaveLength(2);
    expect(w.delivery.sent[1]?.text).toBe("ci: + build failed");

    await advanceBy(w, 5 * 60_000);
    expect(w.delivery.sent).toHaveLength(2);
    w.automations.stop();
  });

  it("unchanged means no model call: a task rule starts no task while the output stays the same", async () => {
    const w = world();
    w.automations.create(
      rule({ action: { kind: "task", workspace_id: w.ws.id, agent: "demo", prompt: "Explain: {{diff}}" } }),
    );
    w.host.script = async ({ callbacks }) => {
      callbacks.output("Looks like the build broke.");
      return "completed";
    };
    w.automations.start();
    w.clock.advance(0);
    await flush();
    await flush();
    expect(w.host.runs).toHaveLength(1);
    expect(w.host.runs[0]?.prompt).toBe("Explain: ok");
    await advanceBy(w, 10 * 60_000);
    expect(w.host.runs).toHaveLength(1);
    expect(w.delivery.sent[0]?.text).toBe("Looks like the build broke.");
    w.automations.stop();
  });

  it("the state survives a restart: an unchanged source stays silent in the new process", async () => {
    const w = world();
    w.automations.create(rule());
    w.automations.start();
    w.clock.advance(0);
    await flush();
    await flush();
    w.automations.stop();
    expect(w.delivery.sent).toHaveLength(1);

    const delivery = new RecordingDelivery();
    const again = setup({
      store: w.store,
      automations: { monitors: w.monitors, state: w.state, delivery },
    });
    again.automations?.start();
    again.clock.advance(0);
    await flush();
    await flush();
    expect(delivery.sent).toHaveLength(0);
    again.automations?.stop();
  });

  it("an unreadable source is reported once, not at every check", async () => {
    const w = world();
    w.monitors.failure = new Error("offline");
    w.automations.create(rule());
    w.automations.start();
    await advanceBy(w, 5 * 60_000);
    expect(w.delivery.sent).toHaveLength(1);
    expect(w.delivery.sent[0]?.text).toContain("couldn't read the source: offline");
    w.automations.stop();
  });

  it("passes the source to the runner as the rule wrote it", async () => {
    const w = world();
    w.automations.create(rule());
    w.automations.start();
    w.clock.advance(0);
    await flush();
    await flush();
    expect(w.monitors.last).toEqual({ kind: "command", command: "gh run list", workspace_id: "ws1" });
    w.automations.stop();
  });
});

describe("automations: reacting to events", () => {
  const onFailure = (over: Partial<AutomationRule> = {}) =>
    notify("failed", { kind: "event", on: "task.failed" }, { action: { kind: "notify", template: "{{task}} — {{reason}}" }, ...over });

  it("a failed task fires the rule, and only once per gap", async () => {
    const w = world(60_000);
    w.automations.create(onFailure());
    w.automations.start();
    w.host.script = async () => {
      throw new Error("agent crashed");
    };
    await w.tasks.whenFinished(w.tasks.create({ workspaceId: w.ws.id, agent: "demo", prompt: "build it" }));
    await flush();
    expect(w.delivery.sent.map((a) => a.text)).toEqual(["build it — agent crashed"]);

    await w.tasks.whenFinished(w.tasks.create({ workspaceId: w.ws.id, agent: "demo", prompt: "again" }));
    await flush();
    expect(w.delivery.sent).toHaveLength(1);

    w.clock.advance(61_000);
    await w.tasks.whenFinished(w.tasks.create({ workspaceId: w.ws.id, agent: "demo", prompt: "third" }));
    await flush();
    expect(w.delivery.sent).toHaveLength(2);
    w.automations.stop();
  });

  it("a rule that starts a task can't feed itself: its own task's failure triggers nothing", async () => {
    const w = world(0);
    w.automations.create(
      onFailure({ action: { kind: "task", workspace_id: w.ws.id, agent: "demo", prompt: "investigate {{task}}" } }),
    );
    w.automations.start();
    w.host.script = async () => {
      throw new Error("still broken");
    };
    await w.tasks.whenFinished(w.tasks.create({ workspaceId: w.ws.id, agent: "demo", prompt: "build it" }));
    await flush();
    await flush();
    await flush();
    expect(w.host.runs.map((r) => r.prompt)).toEqual(["build it", "investigate build it"]);
    w.automations.stop();
  });

  it("monitor.changed rules hear about a monitor's change", async () => {
    const w = world();
    w.automations.create(notify("watch", { kind: "monitor", every: "every 1m", source: { kind: "port", host: "localhost", port: 3000 } }, { importance: "log" }));
    w.automations.create(notify("heard", { kind: "event", on: "monitor.changed" }, { action: { kind: "notify", template: "{{source}} changed" } }));
    w.automations.start();
    w.clock.advance(0);
    await flush();
    await flush();
    expect(w.delivery.sent.map((a) => a.text)).toEqual(["watch changed"]);
    w.automations.stop();
  });
});

// ── suggestions ──────────────────────────────────────────────────────────

describe("suggestions", () => {
  const proposal = (key: string) => ({
    key,
    text: `Watch ${key}?`,
    rule: notify(key, { kind: "schedule", schedule: "every 1h" }),
  });

  it("nothing is created until it is accepted", () => {
    const w = world();
    const id = w.suggestions.offer(proposal("ci"));
    expect(id).toBeDefined();
    expect(w.automations.list()).toEqual([]);
    const rule = w.suggestions.accept(id ?? "");
    expect(w.automations.list().map((r) => r.id)).toEqual([rule.id]);
    expect(w.suggestions.list()).toEqual([]);
  });

  it(`at most ${MAX_PENDING} wait at once`, () => {
    const w = world();
    const ids = Array.from({ length: MAX_PENDING + 2 }, (_, i) => w.suggestions.offer(proposal(`k${i}`)));
    expect(ids.filter(Boolean)).toHaveLength(MAX_PENDING);
    w.suggestions.dismiss(ids[0] ?? "");
    expect(w.suggestions.offer(proposal("k-new"))).toBeDefined();
  });

  it("a dismissed suggestion never comes back, not even after a restart", () => {
    const w = world();
    const id = w.suggestions.offer(proposal("ci"));
    w.suggestions.dismiss(id ?? "");
    expect(w.suggestions.offer(proposal("ci"))).toBeUndefined();
    const again = setup({
      store: w.store,
      automations: { monitors: new FakeMonitors(), state: new MemoryState(), delivery: new RecordingDelivery() },
    });
    expect(again.suggestions?.offer(proposal("ci"))).toBeUndefined();
    expect(again.suggestions?.list()).toEqual([]);
  });

  it("an accepted one isn't offered again, and the same one isn't offered twice while waiting", () => {
    const w = world();
    const id = w.suggestions.offer(proposal("ci"));
    expect(w.suggestions.offer(proposal("ci"))).toBeUndefined();
    w.suggestions.accept(id ?? "");
    expect(w.suggestions.offer(proposal("ci"))).toBeUndefined();
  });

  it("accepting or dismissing something that isn't waiting is refused plainly", () => {
    const w = world();
    expect(() => w.suggestions.accept("nope")).toThrow(/No suggestion waiting/);
    expect(w.suggestions.dismiss("nope")).toBe(false);
  });
});
