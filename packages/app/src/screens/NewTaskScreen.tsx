import type { AgentInfo, AgentSessionInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Mic, Stop } from "../icons";
import { ago, type Model, mayStillBeOpen, pickAgent, recentPrompts, workspaceName } from "../model";
import { Banner, Button, buzz, Card, Choices, Section, styles, Title } from "../ui";
import { useVoice } from "../voice/VoiceProvider";

type Props = {
  model: Model;
  client: LinkClient | undefined;
  /** The agent the last task used, to suggest it again. */
  lastAgent: string | undefined;
  onCreated: (agent: string) => void;
  onClose: () => void;
  status: LinkStatus;
  /** Opens the task just started, so the user sees it begin. */
  onOpenTask: (taskId: string) => void;
  say: (message: string) => void;
};

const STATE_WORDS: Record<AgentInfo["state"], string> = {
  checking: "checking…",
  ready: "",
  needs_sign_in: "needs sign-in",
  unavailable: "not available",
};

/** Three steps (R4): describe it, pick where and with what, go. */
export function NewTaskScreen({
  model,
  client,
  lastAgent,
  onCreated,
  onClose,
  status,
  onOpenTask,
  say,
}: Props) {
  const [workspaceId, setWorkspaceId] = useState(model.workspaces[0]?.id);
  const [chosen, setChosen] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** Earlier conversations of this agent in this project, once asked for. */
  const [earlier, setEarlier] = useState<{ key: string; list: AgentSessionInfo[] }>();
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [resume, setResume] = useState<AgentSessionInfo>();

  // Only a ready agent can be selected; otherwise suggest one that will work.
  const isReady = (name: string | undefined) =>
    model.agents.some((a) => a.name === name && a.state === "ready");
  const agent = isReady(chosen) ? chosen : pickAgent(model.agents, lastAgent);
  const notReady = model.agents.filter(
    (a) => a.state === "needs_sign_in" || a.state === "unavailable",
  );
  const stillChecking = model.agents.some((a) => a.state === "checking");
  const previous = recentPrompts(model);
  const voice = useVoice();
  const [dictating, setDictating] = useState(false);
  const dictate = async () => {
    if (dictating) return voice.stopDictation();
    setDictating(true);
    const before = prompt.trim();
    // Spoken words are added after anything already typed.
    await voice.dictate((text) => setPrompt(before ? `${before} ${text}` : text));
    setDictating(false);
  };
  // A conversation belongs to one agent in one project: changing either forgets the choice.
  const key = `${agent}@${workspaceId}`;
  const shown = earlier?.key === key ? earlier.list : undefined;
  const continuing = shown && resume && shown.some((s) => s.id === resume.id) ? resume : undefined;

  const loadEarlier = async () => {
    if (!client || !workspaceId || !agent) return;
    setLoadingEarlier(true);
    setProblem(undefined);
    try {
      const ack = await client.listSessions({ workspaceId, agent });
      if (ack.ok) setEarlier({ key, list: ack.sessions ?? [] });
      else setProblem(ack.error ?? "The computer couldn't list earlier conversations.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const start = async () => {
    if (!client || !workspaceId || !agent) return;
    const request = client.createTask({
      workspaceId,
      agent,
      prompt: prompt.trim(),
      resume: continuing?.id,
    });
    // Offline: it waits in the queue; don't keep the user on a spinner.
    if (status !== "online") {
      void request
        .then((ack) => !ack.ok && say(ack.error ?? "The computer couldn't start that task."))
        .catch(() => {});
      onCreated(agent);
      say("Queued. It starts as soon as your computer is reachable.");
      onClose();
      return;
    }
    setSending(true);
    setProblem(undefined);
    try {
      const ack = await request;
      if (ack.ok) {
        buzz();
        onCreated(agent);
        if (ack.result) onOpenTask(ack.result);
        else onClose();
      } else setProblem(ack.error ?? "The computer couldn't start that task.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const checkAgain = async () => {
    if (!client) return;
    setChecking(true);
    try {
      await client.checkAgents();
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}>
        <Title>New task</Title>
        <Button title="Cancel" kind="plain" onPress={onClose} />
      </View>

      <TextInput
        style={[styles.input, { minHeight: 110, textAlignVertical: "top" }]}
        multiline
        autoFocus
        placeholder={continuing ? "What next?" : "What should the agent do?"}
        value={prompt}
        onChangeText={setPrompt}
      />
      {voice.canListen ? (
        <View style={{ gap: 6 }}>
          <Button
            title={
              dictating
                ? voice.phase === "working"
                  ? "Improving with Whisper…"
                  : "Done talking"
                : "Dictate"
            }
            icon={dictating ? Stop : Mic}
            kind={dictating ? "danger" : "plain"}
            disabled={voice.phase === "working"}
            onPress={() => void dictate()}
          />
          {dictating && voice.phase === "listening" ? (
            <Text style={styles.muted}>Listening. Pause as you like; tap Done when finished.</Text>
          ) : null}
          {voice.problem && !dictating ? <Banner tone="bad">{voice.problem}</Banner> : null}
        </View>
      ) : null}
      {prompt === "" && previous.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.muted}>Recent requests. Tap one to use it again.</Text>
          <Choices
            options={previous.map((p) => ({
              value: p,
              label: p.length > 40 ? `${p.slice(0, 40)}…` : p,
            }))}
            value={""}
            onChange={setPrompt}
          />
        </View>
      ) : null}

      <Text style={styles.muted}>
        {workspaceId && agent
          ? `In ${workspaceName(model, workspaceId)} with ${model.agents.find((a) => a.name === agent)?.label ?? agent}${continuing ? ` · continuing “${continuing.title || "untitled"}”` : ""}. Change below.`
          : "Pick a project and an agent below."}
      </Text>
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      <Button
        title={sending ? "Sending…" : continuing ? "Continue" : "Start"}
        busy={sending}
        disabled={!client || !workspaceId || !agent || prompt.trim() === ""}
        onPress={() => void start()}
      />

      <Section title="Project">
        {model.workspaces.length === 0 ? (
          <Banner tone="info">
            No project folders yet. In malves serve on the computer, type: add &lt;folder&gt;
          </Banner>
        ) : null}
        <View style={styles.row}>
          {model.workspaces.map((w) => (
            <Button
              key={w.id}
              title={w.name}
              kind={w.id === workspaceId ? "primary" : "plain"}
              onPress={() => setWorkspaceId(w.id)}
            />
          ))}
        </View>
      </Section>

      <Section title="Agent">
        <View style={styles.row}>
          {model.agents.map((a) => (
            <Button
              key={a.name}
              title={a.state === "ready" ? a.label : `${a.label} · ${STATE_WORDS[a.state]}`}
              kind={a.name === agent ? "primary" : "plain"}
              disabled={a.state !== "ready"}
              onPress={() => setChosen(a.name)}
            />
          ))}
        </View>
        {stillChecking ? (
          <Text style={styles.muted}>Checking which agents are ready on your computer…</Text>
        ) : null}
        {notReady.map((a) => (
          <Banner key={a.name} tone="info">
            {a.state === "needs_sign_in"
              ? `${a.label} isn't signed in on your computer. ${a.hint ?? ""}`
              : `${a.label} isn't available right now. ${a.hint ?? ""}`}
          </Banner>
        ))}
        {notReady.length > 0 ? (
          <Button
            title="I've signed in, check again"
            kind="plain"
            busy={checking}
            onPress={() => void checkAgain()}
          />
        ) : null}
      </Section>

      <Section title="Conversation">
        {continuing ? (
          <Card>
            <Text style={styles.body}>Continuing: {continuing.title || "untitled"}</Text>
            {mayStillBeOpen(continuing.updated_at) ? (
              <Banner tone="info">
                Used {ago(continuing.updated_at)}. If it's still open on your computer, close it
                there first, or the two will get mixed up.
              </Banner>
            ) : null}
            <Button
              title="Start a new one instead"
              kind="plain"
              onPress={() => setResume(undefined)}
            />
          </Card>
        ) : (
          <Text style={styles.muted}>A new conversation.</Text>
        )}
        {!continuing && !shown ? (
          <Button
            title="Continue an earlier one"
            kind="plain"
            busy={loadingEarlier}
            disabled={!client || !workspaceId || !agent}
            onPress={() => void loadEarlier()}
          />
        ) : null}
        {!continuing && shown?.length === 0 ? (
          <Text style={styles.muted}>
            No earlier conversations with this agent in this project.
          </Text>
        ) : null}
        {!continuing
          ? shown?.map((s) => (
              <Button
                key={s.id}
                title={`${s.title || "untitled"}${s.updated_at ? ` · ${ago(s.updated_at)}` : ""}`}
                kind="plain"
                onPress={() => setResume(s)}
              />
            ))
          : null}
      </Section>
    </ScrollView>
  );
}
