import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { QuestionCard } from "../components/QuestionCard";
import { TaskRow } from "../components/TaskRow";
import { Desktop, Plus } from "../icons";
import { ago, ideName, type Model, needsYou, recent, running } from "../model";
import { PushCard } from "../PushCard";
import { Banner, Button, Card, color, List, Row, Section, space, styles, Title } from "../ui";
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
  onOpenMalves: () => void;
  onWatchScreen: () => void;
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
  onOpenMalves,
  onWatchScreen,
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
      <View style={{ gap: space.sm }}>
        <Title eyebrow="Your computer">{model.computer ?? "Connecting"}</Title>
        <StatusLine status={status} lastOnline={lastOnline} />
      </View>

      {model.handover.active ? (
        <HandoverBar
          since={model.handover.since}
          onStop={() => void client?.stopHandover().catch(() => {})}
          onWatch={onWatchScreen}
        />
      ) : null}

      {status === "rejected" ? (
        <Card>
          <Banner tone="bad">{detail ?? "This computer no longer accepts this phone."}</Banner>
          <Button title="Pair again" onPress={onPairAgain} />
        </Card>
      ) : null}
      {status === "offline" ? (
        <Banner tone="warn">
          Can't reach your computer. Check it's awake and Tailscale is on. Anything you send now
          waits and goes when it's back.
        </Banner>
      ) : null}

      {status !== "rejected" ? (
        <VoiceBar onOpenConversation={onOpenMalves} handover={model.handover.active} />
      ) : null}

      {questions.length > 0 ? (
        <Section title={`Needs you · ${questions.length}`}>
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
      ) : null}

      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            title="New task"
            icon={Plus}
            onPress={onNewTask}
            disabled={status === "rejected"}
          />
        </View>
        {status === "online" && !model.handover.active ? (
          <View style={{ flex: 1 }}>
            <Button
              title="Your screen"
              kind="secondary"
              icon={Desktop}
              onPress={onWatchScreen}
              hint="Watch the computer's screen live, and control it"
            />
          </View>
        ) : null}
      </View>

      {status === "online" ? <PushCard link={model.push} quiet /> : null}

      {firstRun ? <FirstRun model={model} /> : null}

      {status === "online" && model.ides.length > 0 ? (
        <Section title="At your desk">
          <List>
            {model.ides.map((ide) => (
              <Row
                key={ide.id}
                onPress={() => onOpenIde(ide.id)}
                label={`${ide.app}, open with ${ide.projects.map((p) => p.name).join(", ")}`}
              >
                <Text style={[styles.body, styles.strong]}>{ideName(model, ide)}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {ide.projects.map((p) => p.name).join(", ") || "No folder open"}
                </Text>
              </Row>
            ))}
          </List>
        </Section>
      ) : null}

      {active.length > 0 ? (
        <Section title={`Running · ${active.length}`}>
          <List>
            {active.map((t) => (
              <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
            ))}
          </List>
        </Section>
      ) : null}

      {done.length > 0 ? (
        <Section title="Recent" action={{ label: "See all", onPress: onAllTasks }}>
          <List>
            {done.map((t) => (
              <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
            ))}
          </List>
        </Section>
      ) : null}
    </ScrollView>
  );
}

/** Malves has the computer: a navy bar, always on top of Home, with Stop. */
function HandoverBar({
  since,
  onStop,
  onWatch,
}: {
  since: number | undefined;
  onStop: () => void;
  onWatch: () => void;
}) {
  const at = since
    ? new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ backgroundColor: color.zone, borderRadius: 18, padding: space.lg, gap: space.md }}
    >
      <View style={{ gap: 2 }}>
        <Text style={[styles.eyebrow, { color: color.zoneMuted }]}>Handover</Text>
        <Text style={[styles.body, { color: color.zoneText }]}>
          Malves has your computer{at ? ` since ${at}` : ""}.
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Watch screen"
            icon={Desktop}
            onPress={onWatch}
            hint="See the computer's screen live"
          />
        </View>
        <Button
          title="Stop"
          kind="danger"
          onZone
          onPress={onStop}
          hint="Take the computer back now"
        />
      </View>
    </View>
  );
}

/** What to do first, in order, until the first task runs. */
function FirstRun({ model }: { model: Model }) {
  const ready = model.agents.filter((a) => a.state === "ready" && a.name !== "demo");
  const steps: Array<[boolean, string]> = [
    [
      model.workspaces.length > 0,
      "Add a project folder: on the computer, in malves serve, type add <folder>.",
    ],
    [
      ready.length > 0,
      "Sign in to an agent on the computer (Claude, Codex, Antigravity or Cursor). Settings shows which are ready.",
    ],
    [
      false,
      "Tap New task and describe what you want. The Demo agent asks one question, so you can see how answering works.",
    ],
  ];
  return (
    <Section title="Getting started">
      <List>
        {steps.map(([done, text], i) => (
          <Row key={text}>
            <View style={{ flexDirection: "row", gap: space.md }}>
              <Text style={[styles.meta, { color: done ? color.ok : color.muted, paddingTop: 3 }]}>
                {done ? "DONE" : `0${i + 1}`}
              </Text>
              <Text style={[styles.body, { flex: 1 }, done && { color: color.muted }]}>{text}</Text>
            </View>
          </Row>
        ))}
      </List>
    </Section>
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
    online: ["Online, end-to-end encrypted", color.ok],
    connecting: ["Connecting", color.muted],
    offline: [`Offline, ${seen}retrying`, color.warn],
    rejected: ["Not connected", color.danger],
  }[status];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone }} />
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}
