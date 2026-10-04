import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { countdown, type Model, type Question, workspaceName } from "../model";
import { Banner, Button, buzz, Card, Chip, color, styles } from "../ui";
import { useNow } from "../useNow";
import { useVoice } from "../voice/VoiceProvider";

const TOO_LATE: Record<string, string> = {
  closed: "Too late — this question already closed.",
  unknown_question: "The computer doesn't know this question any more.",
  invalid_choice: "That choice isn't valid any more.",
};

/** Two minutes left: the countdown turns red. */
const URGENT_MS = 2 * 60_000;

/** An agent's question, with a live countdown: silence stops the task (R3). */
export function QuestionCard({
  question,
  model,
  client,
  status,
  onOpenTask,
}: {
  question: Question;
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  /** Shows "See the task" when given. */
  onOpenTask?: (() => void) | undefined;
}) {
  const now = useNow(1000);
  const voice = useVoice();
  const [sending, setSending] = useState<string>();
  const [queued, setQueued] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [diff, setDiff] = useState<string>();
  const task = model.tasks[question.taskId];
  const left = question.expiresAt - now;

  const viewChanges = async () => {
    if (!client) return;
    if (diff !== undefined) return setDiff(undefined);
    const ack = await client.viewChanges(question.taskId).catch(() => undefined);
    setDiff(ack?.ok ? (ack.result ?? "") : (ack?.error ?? "Couldn't get the changes."));
  };

  const choose = async (choiceId: string, label: string) => {
    if (!client) return;
    setSending(choiceId);
    setProblem(undefined);
    // Offline: the answer waits in the queue and goes when the computer is back.
    if (status !== "online") setQueued(label);
    try {
      const ack = await client.answer({ questionId: question.id, choiceId });
      if (ack.ok) buzz();
      else setProblem(TOO_LATE[ack.result ?? ""] ?? ack.error ?? "Not applied.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(undefined);
      setQueued(undefined);
    }
  };

  return (
    <Card>
      <View style={[styles.row, { alignItems: "center" }]}>
        <Chip
          label={`${question.risk} risk`}
          tone={question.risk === "high" ? "bad" : question.risk === "medium" ? "warn" : "plain"}
        />
        <Text
          style={[styles.muted, left < URGENT_MS && { color: color.danger, fontWeight: "700" }]}
        >
          stops in {countdown(question.expiresAt, now)}
        </Text>
      </View>
      <Text style={styles.muted}>
        {task ? `${task.agent} · ${workspaceName(model, task.workspaceId)}` : "Agent"}
        {task ? ` · “${task.prompt.slice(0, 60)}${task.prompt.length > 60 ? "…" : ""}”` : ""}
      </Text>
      <Text style={styles.body} selectable>
        {question.text}
      </Text>
      {question.kind === "commit_approval" ? (
        <Button
          title={diff === undefined ? "View changes" : "Hide changes"}
          kind="plain"
          onPress={() => void viewChanges()}
        />
      ) : null}
      {diff !== undefined ? (
        <ScrollView horizontal style={{ maxHeight: 360 }}>
          <Text style={styles.mono} selectable>
            {diff}
          </Text>
        </ScrollView>
      ) : null}
      <View style={styles.row}>
        {question.choices.map((c) => (
          <Button
            key={c.id}
            title={c.label}
            kind={/reject|skip|deny|no|don't|leave|stop/i.test(c.label) ? "plain" : "primary"}
            busy={sending === c.id && !queued}
            disabled={sending !== undefined}
            onPress={() => void choose(c.id, c.label)}
          />
        ))}
      </View>
      <View style={styles.row}>
        {voice.canListen ? (
          <Button
            title="🎤 Answer by voice"
            kind="plain"
            disabled={voice.mode || sending !== undefined}
            onPress={() => voice.answer(question)}
          />
        ) : null}
        <Button
          title="🔊 Read aloud"
          kind="plain"
          onPress={() =>
            voice.readAloud(
              `${question.text}. Choices: ${question.choices.map((c) => c.label).join(", ")}.`,
            )
          }
        />
      </View>
      {queued ? (
        <Banner tone="info">
          “{queued}” is queued — it goes as soon as your computer is reachable.
        </Banner>
      ) : null}
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      {onOpenTask ? <Button title="See the task" kind="plain" onPress={onOpenTask} /> : null}
    </Card>
  );
}
