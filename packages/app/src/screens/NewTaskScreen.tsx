import type { AgentInfo, AgentSessionInfo, LinkClient } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { ago, type Model, mayStillBeOpen, pickAgent } from "../model";
import { Banner, Button, Card, Section, styles } from "../ui";

type Props = {
  model: Model;
  client: LinkClient | undefined;
  /** The agent the last task used, to suggest it again. */
  lastAgent: string | undefined;
  onCreated: (agent: string) => void;
  onClose: () => void;
};

const STATE_WORDS: Record<AgentInfo["state"], string> = {
  checking: "checking…",
  ready: "",
  needs_sign_in: "needs sign-in",
  unavailable: "not available",
};

/** Three steps (R4): describe it, pick where and with what, go. */
export function NewTaskScreen({ model, client, lastAgent, onCreated, onClose }: Props) {
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
    setSending(true);
    setProblem(undefined);
    try {
      const ack = await client.createTask({
        workspaceId,
        agent,
        prompt: prompt.trim(),
        resume: continuing?.id,
      });
      if (ack.ok) {
        onCreated(agent);
        onClose();
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
      <Text style={styles.title}>New task</Text>

      <TextInput
        style={[styles.input, { minHeight: 120, textAlignVertical: "top" }]}
        multiline
        autoFocus
        placeholder={continuing ? "What next?" : "What should the agent do?"}
        value={prompt}
        onChangeText={setPrompt}
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
            title="I've signed in — check again"
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

      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      <Button
        title={sending ? "Sending…" : continuing ? "Continue" : "Start"}
        busy={sending}
        disabled={!client || !workspaceId || !agent || prompt.trim() === ""}
        onPress={() => void start()}
      />
      <Button title="Cancel" kind="plain" onPress={onClose} />
    </ScrollView>
  );
}
