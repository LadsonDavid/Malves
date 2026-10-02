import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Core, Notifier, OpenQuestion } from "@malves/core";
import type { LoggedEvent } from "@malves/protocol";

/**
 * Stands in for the phone in build step 1: prints what the phone would show and
 * reads answers from the keyboard. Answers go through the same
 * `questions.answer` the phone link will use.
 */
export function attachTerminal(
  core: Core,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream },
  /** Extra commands by first word, e.g. `pair`, `revoke <id>`. */
  commands: Record<string, (args: string[]) => void> = {},
): { close(): void } {
  const print = (line: string) => io.output.write(`${line}\n`);
  const unsubscribe = core.log.subscribe((event) => {
    const line = render(event);
    if (line) print(line);
  });

  const rl = createInterface({ input: io.input, terminal: false });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (line === "") return;
    if (line === "stop") {
      void core.tasks.stopAll();
      return;
    }
    const [word = "", ...args] = line.split(/\s+/);
    const extra = Object.hasOwn(commands, word) ? commands[word] : undefined;
    if (extra) {
      extra(args);
      return;
    }
    const question = core.questions.pending()[0];
    if (!question) {
      print("  No open question. Type `stop` to stop the task.");
      return;
    }
    const index = Number.parseInt(line, 10) - 1;
    const choice = question.choices[index];
    if (!choice || String(index + 1) !== line) {
      print(`  Type a number from 1 to ${question.choices.length}, or \`stop\`.`);
      return;
    }
    const result = core.questions.answer({
      questionId: question.question_id,
      choiceId: choice.id,
      commandId: randomUUID(),
    });
    if (result !== "applied") print(`  Not applied: ${result}`);
  });

  return {
    close() {
      unsubscribe();
      rl.close();
    },
  };
}

function render(event: LoggedEvent): string | undefined {
  switch (event.type) {
    case "task.updated":
      return `• task ${event.data.task_id}: ${event.data.state}${event.data.reason ? ` — ${event.data.reason}` : ""}`;
    case "question.opened":
      return renderQuestion(event.data);
    case "question.closed":
      return `  (${event.data.outcome.replace("_", " ")}${event.data.choice_id ? `: ${event.data.choice_id}` : ""})`;
    case "task.result":
      return `\n${event.data.text}\n`;
    case "error":
      return `! ${event.data.code}: ${event.data.message}`;
    default:
      return undefined;
  }
}

function renderQuestion(q: OpenQuestion): string {
  const seconds = Math.round((q.expires_at - Date.now()) / 1000);
  const choices = q.choices.map((c, i) => `    ${i + 1}. ${c.label}`).join("\n");
  return [
    "",
    `? [${q.kind}, ${q.risk} risk] ${q.text}`,
    choices,
    `  Answer within ${seconds}s, or the task stops. Type a number, or \`stop\`.`,
  ].join("\n");
}

/** No push in step 1; the terminal shows questions as they are logged. */
export const noPush: Notifier = {
  questionOpened: async () => {},
};
