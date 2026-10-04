import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { QuestionCard } from "../components/QuestionCard";
import { TaskRow } from "../components/TaskRow";
import { ago, ideName, type Model, needsYou, recent, running } from "../model";
import { PushCard } from "../PushCard";
import { Banner, Button, Card, color, Section, styles } from "../ui";
import { VoiceBar } from "../voice/VoiceBar";

type Props = {
  model: Model;
  status: LinkStatus;
  detail: string | undefined;
  /** When the link was last online, for "last seen". */
  lastOnline: number | undefined;
  client: LinkClient | undefined;
  onNewTask: () => void;
  onOpenTask: (taskId: string) => void;
  onAllTasks: () => void;
  onOpenIde: (ideId: string) => void;
  onPairAgain: () => void;
};

/**
 * The home screen answers, at a glance: what needs me right now? Then what's
 * running, and a way to start something. Everything else is a tab away.
 */
export function HomeScreen({
  model,
  status,
  detail,
  lastOnline,
  client,
  onNewTask,
  onOpenTask,
  onAllTasks,
  onOpenIde,
  onPairAgain,
}: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const questions = needsYou(model);
  const active = running(model);
  const done = recent(model, 3);
  const firstRun = model.computer !== null && Object.keys(model.tasks).length === 0;

  const refresh = async () => {
    if (!client || status !== "online") return;
    setRefreshing(true);
    await client.checkAgents().catch(() => {});
    setRefreshing(false);
  };

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>{model.computer ?? "Your computer"}</Text>
        <StatusLine status={status} lastOnline={lastOnline} />
      </View>

      {status === "rejected" ? (
        <Card>
          <Banner tone="bad">{detail ?? "This computer no longer accepts this phone."}</Banner>
          <Button title="Pair again" onPress={onPairAgain} />
        </Card>
      ) : null}
      {status === "offline" ? (
        <Banner tone="warn">
          Can't reach your computer. Is it on and awake, with Tailscale running on both? Anything
          you send now is queued and goes when it's back.
        </Banner>
      ) : null}

      {status === "online" ? <PushCard link={model.push} quiet /> : null}

      {status !== "rejected" ? <VoiceBar /> : null}

      <Section title={questions.length > 0 ? `Needs you (${questions.length})` : "Needs you"}>
        {questions.length === 0 ? (
          <Text style={styles.muted}>Nothing needs you. Questions from agents appear here.</Text>
        ) : null}
        {questions.map((q) => (
          <QuestionCard
            key={q.id}
            question={q}
            model={model}
            client={client}
            status={status}
            onOpenTask={() => onOpenTask(q.taskId)}
          />
        ))}
      </Section>

      <Button title="New task" onPress={onNewTask} disabled={status === "rejected"} />

      {firstRun ? <FirstRun model={model} /> : null}

      {status === "online" && model.ides.length > 0 ? (
        <Section title="At your desk">
          {model.ides.map((ide) => (
            <Card
              key={ide.id}
              onPress={() => onOpenIde(ide.id)}
              label={`${ide.app}, open with ${ide.projects.map((p) => p.name).join(", ")}`}
            >
              <Text style={[styles.body, { fontWeight: "600" }]}>{ideName(model, ide)}</Text>
              <Text style={styles.muted} numberOfLines={1}>
                {ide.projects.map((p) => p.name).join(", ") || "No folder open"} · ask its agent,
                continue its conversations
              </Text>
            </Card>
          ))}
        </Section>
      ) : null}

      {active.length > 0 ? (
        <Section title={`Running (${active.length})`}>
          {active.map((t) => (
            <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
          ))}
        </Section>
      ) : null}

      {done.length > 0 ? (
        <Section title="Recent" action={{ label: "See all", onPress: onAllTasks }}>
          {done.map((t) => (
            <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

/** What to do first, in order, until the first task runs. */
function FirstRun({ model }: { model: Model }) {
  const ready = model.agents.filter((a) => a.state === "ready" && a.name !== "demo");
  return (
    <Card>
      <Text style={[styles.body, { fontWeight: "600" }]}>Getting started</Text>
      <Text style={styles.body}>
        {model.workspaces.length > 0 ? "✓" : "1."} Add a project folder: on the computer, in malves
        serve, type add &lt;folder&gt;.
      </Text>
      <Text style={styles.body}>
        {ready.length > 0 ? "✓" : "2."} Sign in to an agent on the computer (Claude, Codex,
        Antigravity or Cursor). Settings shows which are ready.
      </Text>
      <Text style={styles.body}>
        3. Tap New task and describe what you want. Try the Demo agent first: it asks you one
        question, so you can see how answering works.
      </Text>
    </Card>
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
    offline: [`● Offline — ${seen}retrying`, color.warn],
    rejected: ["● Not connected", color.danger],
  }[status];
  return <Text style={{ color: tone, fontWeight: "600" }}>{label}</Text>;
}
