import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  ago,
  type Model,
  modelLine,
  needsYou,
  type Question,
  recent,
  running,
  type Task,
  workspaceName,
} from "../model";
import { PushCard } from "../PushCard";
import { Banner, Button, Card, color, Section, styles } from "../ui";

type Props = {
  model: Model;
  status: LinkStatus;
  detail: string | undefined;
  /** When the link was last online, for "last seen". */
  lastOnline: number | undefined;
  client: LinkClient | undefined;
  onNewTask: () => void;
  onLeads: () => void;
  onUnpair: () => void;
};

/** The home screen answers one question: what needs me right now? */
export function HomeScreen({
  model,
  status,
  detail,
  lastOnline,
  client,
  onNewTask,
  onLeads,
  onUnpair,
}: Props) {
  const questions = needsYou(model);
  const active = running(model);
  const done = recent(model);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>{model.computer ?? "Your computer"}</Text>
        <StatusLine status={status} lastOnline={lastOnline} />
        {status === "online" && model.chrome !== null ? (
          <Text style={styles.muted}>
            {model.chrome
              ? "Chrome: connected — browser tasks can work"
              : "Chrome: not connected (type `extension` on the computer to set it up)"}
          </Text>
        ) : null}
      </View>

      {status === "rejected" ? (
        <Card>
          <Banner tone="bad">{detail ?? "This computer no longer accepts this phone."}</Banner>
          <Button title="Pair again" onPress={onUnpair} />
        </Card>
      ) : null}

      {status === "online" ? <PushCard link={model.push} /> : null}

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

function StatusLine({
  status,
  lastOnline,
}: {
  status: LinkStatus;
  lastOnline: number | undefined;
}) {
  const seen = lastOnline ? `last seen ${ago(new Date(lastOnline).toISOString())}, ` : "";
  const [label, tone] = {
    online: ["● Online", color.ok],
    connecting: ["Connecting…", color.muted],
    offline: [`Offline — ${seen}retrying`, color.warn],
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
  const [diff, setDiff] = useState<string>();
  const task = model.tasks[question.taskId];

  const viewChanges = async () => {
    if (!client) return;
    if (diff !== undefined) return setDiff(undefined);
    const ack = await client.viewChanges(question.taskId).catch(() => undefined);
    setDiff(ack?.ok ? (ack.result ?? "") : (ack?.error ?? "Couldn't get the changes."));
  };
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
      {question.kind === "commit_approval" ? (
        <Button
          title={diff === undefined ? "View changes" : "Hide changes"}
          kind="plain"
          onPress={() => void viewChanges()}
        />
      ) : null}
      {diff !== undefined ? (
        <ScrollView horizontal style={{ maxHeight: 360 }}>
          <Text style={{ fontFamily: "monospace", fontSize: 12 }}>{diff}</Text>
        </ScrollView>
      ) : null}
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
      {modelLine(task, model.agents) ? (
        <Text style={styles.muted}>{modelLine(task, model.agents)}</Text>
      ) : null}
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
      {task.changes ? (
        <Text style={styles.muted}>
          {task.changes.files} file{task.changes.files === 1 ? "" : "s"} changed (+
          {task.changes.added} −{task.changes.removed})
          {task.commit ? ` · committed ${task.commit}` : ""}
        </Text>
      ) : null}
      {modelLine(task, model.agents) ? (
        <Text style={styles.muted}>{modelLine(task, model.agents)}</Text>
      ) : null}
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
