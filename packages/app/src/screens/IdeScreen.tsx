import type { AgentSessionInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { ago, ideName, type Model, mayStillBeOpen } from "../model";
import { Banner, Button, buzz, Card, Section, styles } from "../ui";

/** The agents whose conversations an IDE shares with malves (their IDE extensions use the same store). */
const SHARED = [
  { name: "claude", label: "Claude Code" },
  { name: "codex", label: "Codex" },
];

type Props = {
  ideId: string;
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  say: (message: string) => void;
};

/**
 * One IDE window on your computer: ask its own agent, and pick up the Claude
 * Code / Codex conversations you had in it — here on the phone, or back in the
 * IDE's terminal when you're at the desk.
 */
export function IdeScreen({ ideId, model, client, status, onBack, onOpenTask, say }: Props) {
  const ide = model.ides.find((i) => i.id === ideId);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [result, setResult] = useState<string>();

  if (!ide) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <Button title="‹ Back" kind="plain" onPress={onBack} />
        <Banner tone="info">That IDE window has closed on your computer.</Banner>
      </ScrollView>
    );
  }
  const name = ideName(model, ide);

  const askAgent = async () => {
    if (!client) return;
    setBusy("agent");
    setProblem(undefined);
    setResult(undefined);
    try {
      const ack = await client.ideAgent(ide.id, prompt.trim());
      if (ack.ok) {
        buzz();
        setResult(ack.result ?? "Sent.");
        setPrompt("");
      } else setProblem(ack.error ?? "The IDE couldn't do that.");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Button title="‹ Back" kind="plain" onPress={onBack} />
      <View style={{ gap: 4 }}>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.muted}>
          Open on your computer with {ide.projects.map((p) => p.name).join(", ") || "no folder"}.
        </Text>
      </View>

      <Section title={`Ask ${ide.app}'s own agent`}>
        <Card>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            multiline
            placeholder="What should it do?"
            value={prompt}
            onChangeText={setPrompt}
          />
          <Button
            title="Send to the IDE"
            busy={busy === "agent"}
            disabled={!client || status !== "online" || prompt.trim() === ""}
            onPress={() => void askAgent()}
          />
          <Text style={styles.muted}>
            VS Code starts its agent straight away; Cursor fills in the prompt and waits for you to
            press Enter at the desk. Its approvals stay in the IDE. For phone approvals, start a
            malves task instead.
          </Text>
          {result ? <Banner tone="ok">{result}</Banner> : null}
          {problem ? <Banner tone="bad">{problem}</Banner> : null}
        </Card>
      </Section>

      {ide.projects.map((p) =>
        p.workspace_id ? (
          <Conversations
            key={p.name}
            ideId={ide.id}
            ideName={name}
            project={p.name}
            workspaceId={p.workspace_id}
            model={model}
            client={client}
            status={status}
            onOpenTask={onOpenTask}
            say={say}
          />
        ) : (
          <Banner key={p.name} tone="info">
            {p.name} isn't a malves project yet. On the computer, in malves serve, type add &lt;its
            folder&gt; to work on it from the phone.
          </Banner>
        ),
      )}
    </ScrollView>
  );
}

/** The project's Claude Code and Codex conversations — continue here, or reopen at the desk. */
function Conversations({
  ideId,
  ideName: name,
  project,
  workspaceId,
  model,
  client,
  status,
  onOpenTask,
  say,
}: {
  ideId: string;
  ideName: string;
  project: string;
  workspaceId: string;
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  onOpenTask: (taskId: string) => void;
  say: (message: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [found, setFound] =
    useState<Array<AgentSessionInfo & { agent: string; agentLabel: string }>>();
  const [problem, setProblem] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string>();
  const ready = SHARED.filter((a) =>
    model.agents.some((x) => x.name === a.name && x.state === "ready"),
  );

  const load = async () => {
    if (!client) return;
    setLoading(true);
    setProblem(undefined);
    const lists = await Promise.all(
      ready.map(async (a) => {
        const ack = await client
          .listSessions({ workspaceId, agent: a.name })
          .catch(() => undefined);
        if (!ack?.ok) {
          setProblem(ack?.error ?? `Couldn't list ${a.label} conversations.`);
          return [];
        }
        return (ack.sessions ?? []).map((s) => ({ ...s, agent: a.name, agentLabel: a.label }));
      }),
    );
    setFound(
      lists
        .flat()
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .slice(0, 15),
    );
    setLoading(false);
  };

  const continueHere = async (s: AgentSessionInfo & { agent: string }) => {
    if (!client) return;
    setBusy(s.id);
    const ack = await client
      .createTask({ workspaceId, agent: s.agent, prompt: text.trim(), resume: s.id })
      .catch((error: unknown) => ({ ok: false, error: String(error), result: undefined }));
    setBusy(undefined);
    if (ack.ok && ack.result) {
      buzz();
      setOpen(undefined);
      setText("");
      onOpenTask(ack.result);
    } else setProblem(ack.error ?? "Couldn't continue that conversation.");
  };

  const reopen = async (s: AgentSessionInfo & { agent: string }) => {
    if (!client) return;
    setBusy(`ide-${s.id}`);
    const ack = await client
      .ideResume({ ideId, workspaceId, agent: s.agent, sessionId: s.id })
      .catch((error: unknown) => ({ ok: false, error: String(error), result: undefined }));
    setBusy(undefined);
    if (ack.ok) {
      buzz();
      say(ack.result ?? `Reopened in ${name}.`);
    } else setProblem(ack.error ?? `Couldn't reopen it in ${name}.`);
  };

  return (
    <Section title={`Conversations in ${project}`}>
      {found === undefined ? (
        <Button
          title={
            ready.length > 0
              ? "Show Claude Code and Codex conversations"
              : "No Claude Code or Codex ready"
          }
          kind="plain"
          busy={loading}
          disabled={!client || status !== "online" || ready.length === 0}
          onPress={() => void load()}
        />
      ) : null}
      {found?.length === 0 ? (
        <Text style={styles.muted}>No Claude Code or Codex conversations in {project} yet.</Text>
      ) : null}
      {found?.map((s) => (
        <Card key={`${s.agent}-${s.id}`}>
          <Text style={[styles.body, { fontWeight: "600" }]} numberOfLines={2}>
            {s.title || "Untitled conversation"}
          </Text>
          <Text style={styles.muted}>
            {s.agentLabel}
            {s.updated_at ? ` · ${ago(s.updated_at)}` : ""}
          </Text>
          {mayStillBeOpen(s.updated_at) ? (
            <Banner tone="warn">
              Used {ago(s.updated_at)} — if it's still open in {name}, finish there first, or the
              two will get mixed up.
            </Banner>
          ) : null}
          {open === s.id ? (
            <>
              <TextInput
                style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                multiline
                autoFocus
                placeholder="What next?"
                value={text}
                onChangeText={setText}
              />
              <View style={styles.row}>
                <Button
                  title="Continue"
                  busy={busy === s.id}
                  disabled={text.trim() === ""}
                  onPress={() => void continueHere(s)}
                />
                <Button title="Cancel" kind="plain" onPress={() => setOpen(undefined)} />
              </View>
            </>
          ) : (
            <View style={styles.row}>
              <Button title="Continue here" onPress={() => setOpen(s.id)} />
              <Button
                title={`Reopen in ${name}`}
                kind="plain"
                busy={busy === `ide-${s.id}`}
                hint="Opens a terminal in the IDE that resumes this conversation"
                onPress={() => void reopen(s)}
              />
            </View>
          )}
        </Card>
      ))}
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
    </Section>
  );
}
