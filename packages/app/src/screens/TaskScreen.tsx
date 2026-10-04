import type { Ack, LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { Alert, ScrollView, Share, Text, TextInput, View } from "react-native";
import { QuestionCard } from "../components/QuestionCard";
import { StateChip } from "../components/TaskRow";
import { duration, isFinished, type Model, modelLine, questionsFor, workspaceName } from "../model";
import { Banner, Button, buzz, Card, Section, styles } from "../ui";
import { useNow } from "../useNow";

type Props = {
  taskId: string;
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
  /** A new task was started from here (Reply, Run again): show that one. */
  onOpenTask: (taskId: string) => void;
  say: (message: string) => void;
};

/** Everything about one task: what it's doing now, what it found, what changed, and what next. */
export function TaskScreen({ taskId, model, client, status, onBack, onOpenTask, say }: Props) {
  const task = model.tasks[taskId];
  const now = useNow(task && isFinished(task) ? 60_000 : 1000);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"stop" | "reply" | "again" | "diff">();
  const [problem, setProblem] = useState<string>();
  const [diff, setDiff] = useState<string>();

  if (!task) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Button title="‹ Back" kind="plain" onPress={onBack} />
        <Banner tone="info">
          This task isn't on this phone (yet). Pull down on Home to refresh.
        </Banner>
      </ScrollView>
    );
  }

  const finished = isFinished(task);
  const activity = model.activity[task.id] ?? [];
  const questions = questionsFor(model, task.id);
  const line = modelLine(task, model.agents);
  const offlineNote = status !== "online" ? " (queued until your computer is back)" : "";

  /** Runs a command; a new task id in `result` opens that task. */
  const run = async (kind: typeof busy, send: (c: LinkClient) => Promise<Ack>, done?: string) => {
    if (!client) return;
    setBusy(kind);
    setProblem(undefined);
    if (status !== "online" && done) say(`${done}${offlineNote}`);
    try {
      const ack = await send(client);
      if (!ack.ok) return setProblem(ack.error ?? "The computer couldn't do that.");
      buzz();
      if (done && status === "online") say(done);
      if ((kind === "reply" || kind === "again") && ack.result) onOpenTask(ack.result);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };

  const stop = () =>
    Alert.alert("Stop this task?", "The agent stops at once. Anything it already changed stays.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => void run("stop", (c) => c.stopTask(task.id), "Task stopped"),
      },
    ]);

  const viewChanges = async () => {
    if (!client) return;
    if (diff !== undefined) return setDiff(undefined);
    setBusy("diff");
    const ack = await client.viewChanges(task.id).catch(() => undefined);
    setBusy(undefined);
    setDiff(ack?.ok ? (ack.result ?? "") : (ack?.error ?? "Couldn't get the changes."));
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}>
        <Button title="‹ Back" kind="plain" onPress={onBack} />
        <StateChip state={task.state} />
      </View>

      <View style={{ gap: 6 }}>
        <Text style={styles.muted}>
          {task.agent} · {workspaceName(model, task.workspaceId)} · {duration(task, now)}
          {task.resume ? " · continued conversation" : ""}
        </Text>
        <Text style={[styles.body, { fontSize: 18, fontWeight: "600" }]} selectable>
          {task.prompt}
        </Text>
        {task.reason ? <Text style={styles.muted}>{task.reason}</Text> : null}
        {line ? <Text style={styles.muted}>{line}</Text> : null}
      </View>

      {questions.map((q) => (
        <QuestionCard key={q.id} question={q} model={model} client={client} status={status} />
      ))}

      {!finished || activity.length > 0 ? (
        <Section title={finished ? "What it did" : "Now"}>
          <Card>
            {activity.length === 0 ? (
              <Text style={styles.muted}>
                {finished
                  ? "No steps recorded on this phone."
                  : "Waiting for the agent's first step…"}
              </Text>
            ) : (
              activity
                .slice(-15)
                .reverse()
                .map((a, i) => (
                  <Text
                    key={`${a.at}-${a.text}`}
                    style={i === 0 && !finished ? styles.body : styles.muted}
                  >
                    {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                    · {a.text}
                  </Text>
                ))
            )}
          </Card>
        </Section>
      ) : null}

      {task.result ? (
        <Section
          title="Result"
          action={{
            label: "Share",
            onPress: () => void Share.share({ message: task.result ?? "" }),
          }}
        >
          <Card>
            <Text style={styles.body} selectable>
              {task.result}
            </Text>
          </Card>
        </Section>
      ) : finished ? (
        <Text style={styles.muted}>The agent didn't write a result.</Text>
      ) : null}

      {task.changes ? (
        <Section title="Changes">
          <Card>
            <Text style={styles.body}>
              {task.changes.files} file{task.changes.files === 1 ? "" : "s"} changed (+
              {task.changes.added} −{task.changes.removed})
              {task.commit ? ` · committed ${task.commit}` : " · not committed"}
            </Text>
            <Button
              title={diff === undefined ? "View changes" : "Hide changes"}
              kind="plain"
              busy={busy === "diff"}
              onPress={() => void viewChanges()}
            />
            {diff !== undefined ? (
              <ScrollView horizontal style={{ maxHeight: 420 }}>
                <Text style={styles.mono} selectable>
                  {diff}
                </Text>
              </ScrollView>
            ) : null}
          </Card>
        </Section>
      ) : null}

      {problem ? <Banner tone="bad">{problem}</Banner> : null}

      {!finished ? (
        <Button title="Stop this task" kind="danger" busy={busy === "stop"} onPress={stop} />
      ) : null}

      {finished && task.sessionId && !replying ? (
        <Button title="Reply" onPress={() => setReplying(true)} hint="Continue this conversation" />
      ) : null}
      {replying ? (
        <Card>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            multiline
            autoFocus
            placeholder={`Tell ${task.agent} what next`}
            value={text}
            onChangeText={setText}
          />
          <View style={styles.row}>
            <Button
              title="Send"
              busy={busy === "reply"}
              disabled={text.trim() === ""}
              onPress={() =>
                void run("reply", (c) => c.reply(task.id, text.trim()), "Reply sent").then(() =>
                  setText(""),
                )
              }
            />
            <Button title="Cancel" kind="plain" onPress={() => setReplying(false)} />
          </View>
        </Card>
      ) : null}
      {finished ? (
        <Button
          title="Run again"
          kind="plain"
          busy={busy === "again"}
          hint="Starts a new task with the same request, agent and project"
          onPress={() =>
            void run(
              "again",
              (c) =>
                c.createTask({
                  workspaceId: task.workspaceId,
                  agent: task.agent,
                  prompt: task.prompt,
                }),
              "Started again",
            )
          }
        />
      ) : null}
    </ScrollView>
  );
}
