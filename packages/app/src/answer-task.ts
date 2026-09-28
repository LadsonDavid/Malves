import { commandId, fromBase64, LinkClient } from "@malves/protocol";
import { MalvesNotify } from "../modules/malves-notify/src";
import { loadComputers, phoneKeys } from "./storage";

type TaskData = { runner: string; question: string; choice: string; label: string };

/**
 * Runs without the app on screen when a notification button is tapped: opens
 * the encrypted link to that computer, sends the answer, and reports back.
 * The answer carries a fresh command id, so a retry can never apply twice.
 */
export async function answerFromNotification(data: TaskData): Promise<void> {
  const computer = (await loadComputers()).find((c) => c.runnerId === data.runner);
  if (!computer) {
    MalvesNotify?.finish(data.runner, data.question, "That computer is no longer paired.");
    return;
  }
  const client = new LinkClient({
    url: computer.url,
    runnerPublicKey: fromBase64(computer.publicKey),
    keyPair: await phoneKeys(),
    wish: ["questions"],
    backoff: { baseMs: 500, maxMs: 4000 },
  });
  client.start();
  try {
    const ack = await Promise.race([
      client.send({
        t: "answer",
        id: commandId(),
        question_id: data.question,
        choice_id: data.choice,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 20_000)),
    ]);
    const text =
      ack.result === "applied" || ack.result === "duplicate"
        ? `Sent: ${data.label}`
        : "Too late — that question was already closed.";
    MalvesNotify?.finish(data.runner, data.question, text);
  } catch {
    MalvesNotify?.finish(data.runner, data.question, "Not sent — open malves to answer.");
  } finally {
    client.stop();
  }
}
