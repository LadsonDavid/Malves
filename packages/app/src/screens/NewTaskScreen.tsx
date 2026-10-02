import type { AgentInfo, LinkClient } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { type Model, pickAgent } from "../model";
import { Banner, Button, Section, styles } from "../ui";

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

  // Only a ready agent can be selected; otherwise suggest one that will work.
  const isReady = (name: string | undefined) =>
    model.agents.some((a) => a.name === name && a.state === "ready");
  const agent = isReady(chosen) ? chosen : pickAgent(model.agents, lastAgent);
  const notReady = model.agents.filter(
    (a) => a.state === "needs_sign_in" || a.state === "unavailable",
  );
  const stillChecking = model.agents.some((a) => a.state === "checking");

  const start = async () => {
    if (!client || !workspaceId || !agent) return;
    setSending(true);
    setProblem(undefined);
    try {
      const ack = await client.createTask({ workspaceId, agent, prompt: prompt.trim() });
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
        placeholder="What should the agent do?"
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

      {problem ? <Banner tone="bad">{problem}</Banner> : null}
      <Button
        title={sending ? "Sending…" : "Start"}
        busy={sending}
        disabled={!client || !workspaceId || !agent || prompt.trim() === ""}
        onPress={() => void start()}
      />
      <Button title="Cancel" kind="plain" onPress={onClose} />
    </ScrollView>
  );
}
