import type { Ack, LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Markdown } from "../components/Markdown";
import { ago, mayStillBeOpen } from "../model";
import { BackBar, Banner, Button, buzz, color, space, styles, Title } from "../ui";
import { type SessionRow, TOOL_LABEL } from "./SessionsList";

type Message = NonNullable<Ack["messages"]>[number];

/** One session: its conversation, and a box to carry it on from the phone. */
export function SessionScreen({
  session,
  client,
  status,
  onBack,
  onOpenTask,
  say,
}: {
  session: SessionRow;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  say: (message: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>();
  const [problem, setProblem] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!client || status !== "online") return;
    void client
      .readSession(session.tool, session.id)
      .then((ack) =>
        ack.ok ? setMessages(ack.messages ?? []) : setProblem(ack.error ?? "Couldn't read it."),
      )
      .catch(() => setProblem("Couldn't reach the computer."));
  }, [client, status, session.tool, session.id]);

  const send = async () => {
    if (!client || !text.trim()) return;
    setSending(true);
    setProblem(undefined);
    try {
      const ack = await client.continueSession(session.tool, session.id, text.trim());
      if (!ack.ok) {
        setProblem(ack.error ?? "The computer couldn't continue it.");
        return;
      }
      buzz();
      say(ack.result ?? "Sent.");
      if (ack.task_id) onOpenTask(ack.task_id);
      else onBack();
    } catch {
      setProblem("Couldn't reach the computer.");
    } finally {
      setSending(false);
    }
  };

  const action =
    session.how === "resume"
      ? "Continue"
      : session.how === "bridge"
        ? "Send to Cursor"
        : "Continue as a new session";
  const explain =
    session.how === "resume"
      ? `${TOOL_LABEL[session.tool]} picks this conversation up where it left off.`
      : session.how === "bridge"
        ? "The message goes into this chat in Cursor on your computer."
        : `${TOOL_LABEL[session.tool]}'s editor chats can't be continued from outside, so this starts a new session in the same folder, told what happened so far.`;
  const recent = mayStillBeOpen(new Date(session.updated_at).toISOString());

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <BackBar onBack={onBack} />
      <Title
        eyebrow={`${TOOL_LABEL[session.tool]}${session.source === "editor" ? " · editor" : ""}`}
      >
        {session.title}
      </Title>
      <Text style={styles.meta}>
        {session.folder ?? "Folder unknown"} · {ago(new Date(session.updated_at).toISOString())}
      </Text>

      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {!messages && !problem ? <Text style={styles.muted}>Loading the conversation…</Text> : null}
      {messages?.length === 0 ? (
        <Text style={styles.muted}>No messages could be read from this session.</Text>
      ) : null}
      {messages?.map((m, i) =>
        m.who === "you" ? (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, read once
            key={i}
            style={{
              alignSelf: "flex-end",
              maxWidth: "88%",
              backgroundColor: color.tint,
              borderRadius: 18,
              borderBottomRightRadius: 4,
              paddingHorizontal: space.md + 2,
              paddingVertical: space.sm + 2,
            }}
          >
            <Text style={styles.body} selectable numberOfLines={12}>
              {m.text}
            </Text>
          </View>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, read once
          <View key={i} style={{ gap: 2 }}>
            <Text style={styles.meta}>{TOOL_LABEL[session.tool].toUpperCase()}</Text>
            <Markdown text={m.text} />
          </View>
        ),
      )}

      <View style={{ gap: space.sm, marginTop: space.md }}>
        <Text style={styles.eyebrow}>Carry on</Text>
        <Text style={styles.muted}>{explain}</Text>
        {recent && session.how === "resume" ? (
          <Banner tone="info">
            Used {ago(new Date(session.updated_at).toISOString())}. If it's still open on your
            computer, close it there first, or the two will get mixed up.
          </Banner>
        ) : null}
        <TextInput
          style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
          multiline
          placeholder="What next?"
          value={text}
          onChangeText={setText}
        />
        <Button
          title={sending ? "Sending…" : action}
          busy={sending}
          disabled={!client || status !== "online" || !text.trim()}
          onPress={() => void send()}
        />
      </View>
    </ScrollView>
  );
}
