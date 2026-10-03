import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  type Model,
  needsYou,
  type Question,
  recent,
  running,
  type Task,
  workspaceName,
} from "../model";
import { Banner, Button, Card, color, Section, styles } from "../ui";

type Props = {
  model: Model;
  status: LinkStatus;
  detail: string | undefined;
  client: LinkClient | undefined;
  onNewTask: () => void;
  onLeads: () => void;
  onUnpair: () => void;
};

/** The home screen answers one question: what needs me right now? */
export function HomeScreen({ model, status, detail, client, onNewTask, onLeads, onUnpair }: Props) {
  const questions = needsYou(model);
  const active = running(model);
  const done = recent(model);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>{model.computer ?? "Your computer"}</Text>
        <StatusLine status={status} />
      </View>

      {status === "rejected" ? (
        <Card>
          <Banner tone="bad">{detail ?? "This computer no longer accepts this phone."}</Banner>
          <Button title="Pair again" onPress={onUnpair} />
        </Card>
      ) : null}

      <Section title={`Needs you (${questions.length})`}>
        {questions.length === 0 ? <Text style={styles.muted}>Nothing needs you.</Text> : null}
        {questions.map((q) => (
          <QuestionCard key={q.id} question={q} model={model} client={client} />
        ))}
      </Section>

      <Section title={`Running (${active.length})`}>
        {active.length === 0 ? <Text style={styles.muted}>No tasks running.</Text> : null}
        {active.map((t) => (
          <RunningTask key={t.id} task={t} model={model} client={client} />
        ))}
      </Section>

      <Button title="New task" onPress={onNewTask} disabled={status === "rejected"} />
      <Button title="Leads" kind="plain" onPress={onLeads} disabled={status === "rejected"} />

      {done.length > 0 ? (
        <Section title="Recent">
          {done.map((t) => (
            <FinishedTask key={t.id} task={t} model={model} client={client} />
          ))}
        </Section>
      ) : null}

      <Button title="Unpair this phone" kind="plain" onPress={onUnpair} />
    </ScrollView>
  );
}

function StatusLine({ status }: { status: LinkStatus }) {
  const [label, tone] = {
    online: ["● Online", color.ok],
    connecting: ["Connecting…", color.muted],
    offline: ["Offline — retrying", color.warn],
    rejected: ["Not connected", color.danger],
  }[status];
  return <Text style={{ color: tone, fontWeight: "600" }}>{label}</Text>;
}

const TOO_LATE: Record<string, string> = {
  closed: "Too late — this question already closed.",
  unknown_question: "The computer doesn't know this question any more.",
  invalid_choice: "That choice isn't valid any more.",
};

function QuestionCard({
  question,
  model,
  client,
}: {
  question: Question;
  model: Model;
  client: LinkClient | undefined;
}) {
  const [sending, setSending] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const task = model.tasks[question.taskId];
  const minutes = Math.max(0, Math.round((question.expiresAt - Date.now()) / 60_000));

  const choose = async (choiceId: string) => {
    if (!client) return;
    setSending(choiceId);
    setProblem(undefined);
    try {
      const ack = await client.answer({ questionId: question.id, choiceId });
      if (!ack.ok) setProblem(TOO_LATE[ack.result ?? ""] ?? ack.error ?? "Not applied.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(undefined);
    }
  };

  return (
    <Card>
      <Text style={styles.muted}>
        {task ? `${task.agent} · ${workspaceName(model, task.workspaceId)}` : "Agent"} ·{" "}
        {question.risk} risk · stops in ~{minutes} min if unanswered
      </Text>
      <Text style={styles.body}>{question.text}</Text>
      <View style={styles.row}>
        {question.choices.map((c) => (
          <Button
            key={c.id}
            title={c.label}
            kind={/reject|skip|deny|no/i.test(c.label) ? "plain" : "primary"}
            busy={sending === c.id}
            disabled={sending !== undefined}
            onPress={() => void choose(c.id)}
          />
        ))}
      </View>
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
    </Card>
  );
}

function RunningTask({
  task,
  model,
  client,
}: {
  task: Task;
  model: Model;
  client: LinkClient | undefined;
}) {
  const [stopping, setStopping] = useState(false);
  return (
    <Card>
      <Text style={styles.muted}>
        {task.agent} · {workspaceName(model, task.workspaceId)} · {task.state}
      </Text>
      <Text style={styles.body} numberOfLines={3}>
        {task.prompt}
      </Text>
      <Button
        title="Stop"
        kind="danger"
        busy={stopping}
        onPress={() => {
          if (!client) return;
          setStopping(true);
          client
            .stopTask(task.id)
            .catch(() => {})
            .finally(() => setStopping(false));
        }}
      />
    </Card>
  );
}

function FinishedTask({
  task,
  model,
  client,
}: {
  task: Task;
  model: Model;
  client: LinkClient | undefined;
}) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const send = async () => {
    if (!client) return;
    setSending(true);
    setProblem(undefined);
    try {
      const ack = await client.reply(task.id, text.trim());
      if (!ack.ok) return setProblem(ack.error ?? "The computer couldn't send the reply.");
      setReplying(false);
      setText("");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };
  const tone =
    task.state === "done" ? color.ok : task.state === "failed" ? color.danger : color.muted;
  return (
    <Card>
      <Text style={{ color: tone, fontWeight: "600" }}>
        {task.state} · {task.agent} · {workspaceName(model, task.workspaceId)}
        {task.resume ? " · continued" : ""}
      </Text>
      <Text style={styles.body} numberOfLines={2}>
        {task.prompt}
      </Text>
      {task.reason ? <Text style={styles.muted}>{task.reason}</Text> : null}
      {task.result ? (
        <Text style={styles.muted} numberOfLines={6}>
          {task.result}
        </Text>
      ) : null}
      {task.sessionId && !replying ? (
        <Button title="Reply" kind="plain" onPress={() => setReplying(true)} />
      ) : null}
      {replying ? (
        <>
          <TextInput
            style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
            multiline
            autoFocus
            placeholder={`Tell ${task.agent} what next`}
            value={text}
            onChangeText={setText}
          />
          <View style={styles.row}>
            <Button
              title="Send"
              busy={sending}
              disabled={text.trim() === ""}
              onPress={() => void send()}
            />
            <Button title="Cancel" kind="plain" onPress={() => setReplying(false)} />
          </View>
        </>
      ) : null}
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
    </Card>
  );
}
