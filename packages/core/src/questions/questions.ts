import type { DataOf } from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Clock, Decision, Ids, Notifier } from "../ports.js";

export type Ask = Decision & {
  taskId: string;
  timeoutMs: number;
};

export type Answer =
  | { outcome: "answered"; choiceId: string }
  | { outcome: "timed_out" }
  | { outcome: "cancelled" };

/** What happened to an answer sent by the phone or the terminal. */
export type AnswerResult =
  /** This answer decided the question. */
  | "applied"
  /** The same command was already applied; nothing changed. */
  | "duplicate"
  /** The question was already answered, timed out or cancelled. First answer wins. */
  | "closed"
  | "unknown_question"
  | "invalid_choice";

export type OpenQuestion = DataOf<"question.opened">;

type Waiter = { resolve: (answer: Answer) => void; cancelTimer: () => void };

/**
 * Every human decision goes through here: agent questions, permission
 * requests, browser actions, the budget floor, commit approval (§3).
 *
 * Rules it owns:
 * - every question is in the log before anyone is told about it;
 * - the first answer wins, and a repeated command is recognised, not re-applied;
 * - on timeout the answer is `timed_out`, and callers must stop (R3);
 * - a push failure never affects the question.
 */
export class Questions {
  private readonly open = new Map<string, OpenQuestion>();
  private readonly seen = new Set<string>();
  private readonly commands = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly log: EventLog,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly notifier: Notifier,
  ) {
    log.subscribe((event) => {
      if (event.type === "question.opened") {
        this.open.set(event.data.question_id, event.data);
        this.seen.add(event.data.question_id);
      } else if (event.type === "question.closed") {
        this.open.delete(event.data.question_id);
        if (event.data.command_id) {
          this.commands.set(event.data.command_id, event.data.question_id);
        }
      }
    });
  }

  ask(input: Ask): Promise<Answer> {
    if (!(input.timeoutMs > 0)) throw new Error("ask: timeoutMs must be positive");
    const choiceIds = new Set(input.choices.map((c) => c.id));
    if (input.choices.length === 0 || choiceIds.size !== input.choices.length) {
      throw new Error("ask: choices must be non-empty with unique ids");
    }

    const questionId = this.ids.next("q");
    const data: OpenQuestion = {
      question_id: questionId,
      task_id: input.taskId,
      kind: input.kind,
      text: input.text,
      choices: input.choices,
      risk: input.risk,
      expires_at: this.clock.now() + input.timeoutMs,
    };

    const answer = new Promise<Answer>((resolve) => {
      const cancelTimer = this.clock.schedule(input.timeoutMs, () =>
        this.close(questionId, { outcome: "timed_out" }),
      );
      this.waiters.set(questionId, { resolve, cancelTimer });
    });

    try {
      this.log.append({ type: "question.opened", data });
    } catch (error) {
      this.waiters.get(questionId)?.cancelTimer();
      this.waiters.delete(questionId);
      throw error;
    }

    this.notifier.questionOpened(data).catch((error: unknown) => {
      this.log.append({
        type: "error",
        data: { code: "push_failed", message: String(error), task_id: input.taskId },
      });
    });

    return answer;
  }

  answer(input: { questionId: string; choiceId: string; commandId: string }): AnswerResult {
    if (this.commands.get(input.commandId) === input.questionId) return "duplicate";

    const question = this.open.get(input.questionId);
    if (!question) return this.seen.has(input.questionId) ? "closed" : "unknown_question";

    if (!question.choices.some((c) => c.id === input.choiceId)) return "invalid_choice";

    if (this.clock.now() >= question.expires_at) {
      this.close(input.questionId, { outcome: "timed_out" });
      return "closed";
    }

    this.close(
      input.questionId,
      { outcome: "answered", choiceId: input.choiceId },
      input.commandId,
    );
    return "applied";
  }

  /** Closes every open question for a task, e.g. when the task is stopped. */
  cancelTask(taskId: string): void {
    for (const question of [...this.open.values()]) {
      if (question.task_id === taskId) this.close(question.question_id, { outcome: "cancelled" });
    }
  }

  /**
   * After a restart nobody is waiting for questions left open in the log, so
   * they are closed as cancelled. Call once, after `EventLog.load()`.
   */
  recover(): void {
    for (const id of [...this.open.keys()]) {
      if (!this.waiters.has(id)) this.close(id, { outcome: "cancelled" });
    }
  }

  pending(): OpenQuestion[] {
    return [...this.open.values()];
  }

  private close(questionId: string, answer: Answer, commandId?: string): void {
    const question = this.open.get(questionId);
    if (!question) return;

    this.log.append({
      type: "question.closed",
      data: {
        question_id: questionId,
        task_id: question.task_id,
        outcome: answer.outcome,
        ...(answer.outcome === "answered" ? { choice_id: answer.choiceId } : {}),
        ...(commandId ? { command_id: commandId } : {}),
      },
    });

    const waiter = this.waiters.get(questionId);
    this.waiters.delete(questionId);
    waiter?.cancelTimer();
    waiter?.resolve(answer);
  }
}
