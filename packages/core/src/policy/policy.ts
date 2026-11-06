import type { Autonomy, Tier } from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Clock } from "../ports.js";
import { type Advisor, advisorPrompt, parseAdvice } from "./advisor.js";
import { classifyCommand, insideRoot, isSecretPath } from "./command.js";
import { matchesPath, matchesText } from "./glob.js";
import type { Action, Classification, PolicyContext, Verdict } from "./types.js";

/**
 * Hard denials that no autonomy setting can lift: they never reach a prompt.
 * Settings add to this list; nothing removes from it.
 */
export const DEFAULT_DENY: readonly string[] = [
  "rm -rf /*",
  "rm -rf ~*",
  "rm -rf *",
  "*format c:*",
  "git push*--force*",
  "git push* -f*",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.aws/credentials",
];

export type PolicyOptions = {
  log: EventLog;
  clock: Clock;
  /** Extra hard-deny globs (commands and paths). */
  denyGlobs?: () => readonly string[];
  /** Sites already approved: reading them is tier 1, clicking inside them tier 2. */
  allowedHosts?: () => readonly string[];
  /** Applications the computer operator may click and type in (tier 2). */
  allowedApps?: () => readonly string[];
  advisor?: Advisor | undefined;
  /** Under `trusting`, a yes stays valid for this long for the identical command. Default 10 minutes. */
  rememberMs?: number;
};

const RANK: Record<Autonomy, number> = { careful: 0, normal: 1, trusting: 2 };

/**
 * The policy engine (plan F1): deterministic code that decides allow, deny or
 * ask for every action. The brain proposes; this decides.
 *
 * Invariants, each with a test:
 *  - an `allow` above tier 2 exists only for an identical action answered yes a
 *    moment ago (`remembered`), and never for delete, spend or message;
 *  - the advisor can lower an `unknown` command to tier 2, nothing else;
 *  - every decision above a silent read, and every refusal, is logged.
 */
export class Policy {
  private readonly autonomy = new Map<string, Autonomy>();
  private readonly yes = new Map<string, number>();

  constructor(private readonly o: PolicyOptions) {
    o.log.subscribe((event) => {
      if (event.type === "policy.autonomy") {
        this.autonomy.set(event.data.workspace_id, event.data.autonomy);
      }
    });
  }

  /** A project's autonomy. `"*"` caps every project: `careful` there turns it all down. */
  setAutonomy(workspaceId: string, autonomy: Autonomy): void {
    this.o.log.append({ type: "policy.autonomy", data: { workspace_id: workspaceId, autonomy } });
  }

  autonomyFor(workspaceId?: string): Autonomy {
    const project = (workspaceId ? this.autonomy.get(workspaceId) : undefined) ?? "careful";
    const cap = this.autonomy.get("*");
    return cap && RANK[cap] < RANK[project] ? cap : project;
  }

  async evaluate(action: Action, ctx: PolicyContext): Promise<Verdict> {
    const verdict = await this.decide(action, ctx);
    if (!(verdict.outcome === "allow" && verdict.tier === 1)) {
      this.o.log.append({
        type: "policy.decided",
        data: {
          ...(ctx.taskId ? { task_id: ctx.taskId } : {}),
          source: action.source,
          kind: action.kind,
          tier: verdict.tier,
          outcome: verdict.outcome,
          why: clip(verdict.why, 300),
          summary: clip(action.summary, 300),
        },
      });
    }
    return verdict;
  }

  /**
   * The person answered yes to this action. Under `trusting`, the identical
   * command is then allowed without asking for a few minutes. Nothing else is
   * ever remembered, and silence is never a yes.
   */
  rememberYes(action: Action, ctx: PolicyContext): void {
    if (this.autonomyFor(ctx.workspaceId) !== "trusting" || !rememberable(action)) return;
    this.yes.set(keyOf(action, ctx), this.o.clock.now() + (this.o.rememberMs ?? 10 * 60_000));
  }

  /** The classifier alone, without autonomy, advisor or logging. For tests and `malves audit`. */
  classify(action: Action, ctx: PolicyContext): Classification {
    return this.classifyAction(action, ctx);
  }

  private async decide(action: Action, ctx: PolicyContext): Promise<Verdict> {
    const denied = this.denied(action);
    if (denied) return { outcome: "deny", tier: 3, why: `Refused for good: ${denied}` };

    let found = this.classifyAction(action, ctx);
    if (found.unknown && this.o.advisor && action.kind === "execute" && action.command) {
      found = await this.advise(action.command, found);
    }

    const mode = this.autonomyFor(ctx.workspaceId);
    if (found.tier === 1) return { outcome: "allow", tier: 1, why: found.why };
    if (found.tier === 2) {
      return { outcome: mode === "careful" ? "ask" : "allow", tier: 2, why: found.why };
    }
    const key = keyOf(action, ctx);
    const until = this.yes.get(key);
    if (mode === "trusting" && rememberable(action) && until !== undefined) {
      if (this.o.clock.now() < until) {
        return {
          outcome: "allow",
          tier: 3,
          why: `${found.why} (you said yes a moment ago)`,
          remembered: true,
        };
      }
      this.yes.delete(key);
    }
    return { outcome: "ask", tier: 3, why: found.why };
  }

  private async advise(command: string, found: Classification): Promise<Classification> {
    const { system, user } = advisorPrompt(command);
    try {
      const answer = await this.o.advisor?.judge(system, user);
      if (answer !== undefined && parseAdvice(answer) === "safe") {
        return { tier: 2, why: "It isn't in the known list, but the advisor judged it routine." };
      }
    } catch {
      // No advisor, no lowering: the command stays at tier 3.
    }
    return found;
  }

  private denied(action: Action): string | undefined {
    const globs = [...DEFAULT_DENY, ...(this.o.denyGlobs?.() ?? [])];
    const words = (action.command ?? "").split(/\s+/).filter(Boolean);
    const paths = [...(action.paths ?? []), ...words];
    if (action.command && matchesText(globs, action.command))
      return `"${clip(action.command, 80)}"`;
    const hit = paths.find((p) => matchesPath(globs, p));
    return hit ? `"${clip(hit, 80)}"` : undefined;
  }

  private classifyAction(action: Action, ctx: PolicyContext): Classification {
    const paths = action.paths ?? [];
    const outside = paths.find((p) => !insideRoot(p, ctx.root));
    const secret = paths.find((p) => isSecretPath(p));
    switch (action.kind) {
      case "read":
      case "search":
        if (outside) return t3("It reads outside the project.");
        if (secret) return t3("It reads a file that may hold a secret.");
        return t1("It only reads inside the project.");
      case "edit":
        if (paths.length === 0) return t3("It doesn't say which files it changes.");
        if (outside) return t3("It changes a file outside the project.");
        if (secret) return t3("It changes a file that may hold a secret.");
        return t2("An edit inside the project can be undone with git.");
      case "move":
        if (paths.length === 0) return t3("It doesn't say which files it moves.");
        if (outside) return t3("It moves a file outside the project.");
        if (secret) return t3("It moves a file that may hold a secret.");
        return t2("A move inside the project can be undone.");
      case "delete":
        return t3("Deleting always asks.");
      case "execute":
        return action.command
          ? classifyCommand(action.command, ctx.root)
          : { tier: 3, why: "It doesn't say what it runs.", unknown: true };
      case "network":
        return this.hostAllowed(action.url)
          ? t1("It reads a site you already approved.")
          : t3("It reaches a site you haven't approved.");
      case "browser":
        return this.browser(action);
      case "computer":
        return this.computer(action);
      case "spend":
        return t3("Spending money always asks.");
      case "message":
        return t3("Sending a message always asks.");
    }
  }

  /** Reading an approved site is tier 1, clicking inside it tier 2, submitting or buying tier 3. */
  private browser(action: Action): Classification {
    if (!this.hostAllowed(action.url)) return t3("It uses a site you haven't approved.");
    const op = (action.command ?? "").toLowerCase();
    if (op === "read" || op === "snapshot" || op === "extract")
      return t1("It reads a site you approved.");
    if (op === "click" || op === "scroll" || op === "navigate") {
      return t2("A click inside an approved site is logged.");
    }
    return t3("Submitting, sending, buying and deleting always ask.");
  }

  /** Looking and moving is tier 1; clicking and typing in an allowed app tier 2; the rest tier 3. */
  private computer(action: Action): Classification {
    const op = (action.command ?? "").toLowerCase();
    if (op === "look" || op === "move") return t1("Looking and moving change nothing.");
    const app = (action.app ?? "").toLowerCase();
    const allowed = (this.o.allowedApps?.() ?? []).some((a) => a.toLowerCase() === app);
    if (
      ["click", "double", "right", "type", "keys", "scroll", "drag", "wait"].includes(op) &&
      allowed
    ) {
      return t2("Clicks and typing in an allowed app are logged.");
    }
    return t3("Send, delete, install, pay and confirm, and any app not on the list, always ask.");
  }

  private hostAllowed(url?: string): boolean {
    if (!url || !URL.canParse(url)) return false;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return (this.o.allowedHosts?.() ?? []).some((h) => {
      const allowed = h.toLowerCase();
      return host === allowed || host.endsWith(`.${allowed}`);
    });
  }
}

/** Only a command run in a project is ever remembered. Delete, spend, message, browser and computer ask every time. */
function rememberable(action: Action): boolean {
  return action.kind === "execute" && action.command !== undefined;
}

function keyOf(action: Action, ctx: PolicyContext): string {
  return [ctx.root, action.source, action.kind, action.command ?? "", ...(action.paths ?? [])].join(
    "\u0000",
  );
}

const t1 = (why: string): Classification => ({ tier: 1 as Tier, why });
const t2 = (why: string): Classification => ({ tier: 2 as Tier, why });
const t3 = (why: string): Classification => ({ tier: 3 as Tier, why });

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
