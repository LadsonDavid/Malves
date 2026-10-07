import type { Ack, AgentInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Mic, Stop } from "../icons";
import { type Model, pickAgent, recentPrompts } from "../model";
import { Banner, Button, buzz, Choices, Section, styles, Title } from "../ui";

type Folder = NonNullable<Ack["folders"]>[number];
/** The folder picker shows the most recently used ones. */
const SHOWN_FOLDERS = 12;

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

/** Three steps (R4): describe it, pick a folder and an agent, go. Folders come from your sessions. */
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
  const [folders, setFolders] = useState<Folder[]>();
  const [folder, setFolder] = useState<string>();
  const [chosen, setChosen] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();

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
  // Your folders: the ones you worked in with Claude, Codex, Cursor or Antigravity, newest first.
  useEffect(() => {
    if (!client || status !== "online") return;
    void client
      .allSessions()
      .then((ack) => {
        const list = ack.ok ? (ack.folders ?? []) : [];
        setFolders(list);
        setFolder((current) => current ?? list[0]?.path);
      })
      .catch(() => setFolders([]));
  }, [client, status]);
  const folderName = folders?.find((f) => f.path === folder)?.name;

  const start = async () => {
    if (!client || !folder || !agent) return;
    const request = client.createTask({ folder, agent, prompt: prompt.trim() });
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
        placeholder="What should the agent do?"
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
        {folder && agent
          ? `In ${folderName ?? folder} with ${model.agents.find((a) => a.name === agent)?.label ?? agent}. Change below.`
          : "Pick a folder and an agent below."}
      </Text>
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      <Button
        title={sending ? "Sending…" : "Start"}
        busy={sending}
        disabled={!client || !folder || !agent || prompt.trim() === ""}
        onPress={() => void start()}
      />

      <Section title="Folder">
        {folders === undefined ? (
          <Text style={styles.muted}>Loading your folders…</Text>
        ) : folders.length === 0 ? (
          <Banner tone="info">
            No folders yet. Work in one with Claude, Codex, Cursor or Antigravity on the computer,
            or add one there: pnpm malves console add &lt;folder&gt;
          </Banner>
        ) : (
          <Choices
            options={folders.slice(0, SHOWN_FOLDERS).map((f) => ({ value: f.path, label: f.name }))}
            value={folder ?? ""}
            onChange={setFolder}
          />
        )}
        {folder ? <Text style={styles.meta}>{folder}</Text> : null}
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
    </ScrollView>
  );
}
