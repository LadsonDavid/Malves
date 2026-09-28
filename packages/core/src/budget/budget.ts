import type { DataOf } from "@malves/protocol";
import type { EventLog } from "../events/log.js";

export type BudgetPolicy = {
  /**
   * Models coding tasks may use ("quality floor"). Patterns with `*`, matched
   * against the normalised model name. Empty: any model — but a model other
   * than the one requested still has to be approved.
   */
  floor: string[];
};

export type ModelCheck =
  | { ok: true }
  | { ok: false; reason: "below_floor" | "switched"; message: string };

export type Usage = DataOf<"budget.updated">;

/**
 * The budget rules (§6, R8). The guard in front of the model gateway asks
 * these before passing any answer back to an agent, so a weaker model never
 * takes over silently.
 */
export class Budget {
  /** Models a person explicitly allowed for one task. */
  private readonly allowed = new Map<string, Set<string>>();

  constructor(
    private readonly log: EventLog,
    private readonly policy: BudgetPolicy,
  ) {}

  check(input: {
    taskId: string;
    browser: boolean;
    requested?: string;
    answered: string;
  }): ModelCheck {
    const answered = normalise(input.answered);
    if (this.allowed.get(input.taskId)?.has(answered)) return { ok: true };

    // Browser tasks run on cheap models by design (§5); the floor is for code.
    if (!input.browser && this.policy.floor.length > 0) {
      if (!this.policy.floor.some((pattern) => matches(pattern, answered))) {
        return {
          ok: false,
          reason: "below_floor",
          message: `${input.answered} answered, which is below your quality floor for coding tasks.`,
        };
      }
      return { ok: true };
    }

    const requested = input.requested ? normalise(input.requested) : "";
    if (requested && !isRouterAlias(requested) && !sameModel(requested, answered)) {
      return {
        ok: false,
        reason: "switched",
        message: `You asked for ${input.requested}, but ${input.answered} answered.`,
      };
    }
    return { ok: true };
  }

  /** A person said yes to this model for this task. */
  allow(taskId: string, model: string): void {
    const set = this.allowed.get(taskId) ?? new Set<string>();
    set.add(normalise(model));
    this.allowed.set(taskId, set);
  }

  record(usage: Usage): void {
    this.log.append({ type: "budget.updated", data: usage });
  }
}

/** "openai/GPT-4o-2024-08-06" → "gpt-4o"; ":free" and date suffixes dropped. */
export function normalise(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:[a-z-]+$/, "")
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-latest$/, "");
}

export function sameModel(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  return x === y;
}

function matches(pattern: string, model: string): boolean {
  const STAR = "__star__";
  const escaped = normalise(pattern.replaceAll("*", STAR))
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(STAR, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/** Names that ask the gateway to choose, so any answer is a legitimate choice. */
function isRouterAlias(model: string): boolean {
  return ["auto", "default", "any", "free", "router"].includes(model);
}
