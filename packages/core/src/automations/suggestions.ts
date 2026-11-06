import type { AutomationRule } from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Ids } from "../ports.js";
import type { Automations, Rule } from "./automations.js";

export type Suggestion = { id: string; key: string; text: string; rule: AutomationRule };

/** At most this many suggestions wait for an answer at once. */
export const MAX_PENDING = 5;

/**
 * Malves proposing rules ("you check CI after every push, watch it?"). The
 * rules of the game (Hermes `cron/suggestions.py`):
 *  - nothing is created without a tap (`accept`);
 *  - at most five wait at once, extras are simply not offered;
 *  - a dismissed suggestion never returns: its key is kept for good;
 *  - an accepted one is not offered again either.
 */
export class Suggestions {
  private readonly pending = new Map<string, Suggestion>();
  private readonly closedKeys = new Set<string>();

  constructor(
    private readonly log: EventLog,
    private readonly ids: Ids,
    private readonly automations: Pick<Automations, "create">,
  ) {
    log.subscribe((event) => {
      switch (event.type) {
        case "suggestion.offered": {
          const d = event.data;
          this.pending.set(d.suggestion_id, {
            id: d.suggestion_id,
            key: d.key,
            text: d.text,
            rule: d.rule,
          });
          break;
        }
        case "suggestion.accepted": {
          const s = this.pending.get(event.data.suggestion_id);
          if (s) this.closedKeys.add(s.key);
          this.pending.delete(event.data.suggestion_id);
          break;
        }
        case "suggestion.dismissed":
          this.closedKeys.add(event.data.key);
          this.pending.delete(event.data.suggestion_id);
          break;
      }
    });
  }

  /** Returns the id, or `undefined` when it wasn't offered (full, dismissed, accepted, or already waiting). */
  offer(input: { key: string; text: string; rule: AutomationRule }): string | undefined {
    if (this.closedKeys.has(input.key)) return undefined;
    if (this.list().some((s) => s.key === input.key)) return undefined;
    if (this.pending.size >= MAX_PENDING) return undefined;
    const id = this.ids.next("s");
    this.log.append({
      type: "suggestion.offered",
      data: { suggestion_id: id, key: input.key, text: input.text, rule: input.rule },
    });
    return id;
  }

  /** The person said yes: the rule is created. */
  accept(id: string): Rule {
    const suggestion = this.pending.get(id);
    if (!suggestion) throw new Error(`No suggestion waiting: ${id}`);
    const rule = this.automations.create(suggestion.rule);
    this.log.append({ type: "suggestion.accepted", data: { suggestion_id: id, rule_id: rule.id } });
    return rule;
  }

  dismiss(id: string): boolean {
    const suggestion = this.pending.get(id);
    if (!suggestion) return false;
    this.log.append({
      type: "suggestion.dismissed",
      data: { suggestion_id: id, key: suggestion.key },
    });
    return true;
  }

  list(): Suggestion[] {
    return [...this.pending.values()];
  }
}
