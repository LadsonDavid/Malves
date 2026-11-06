import type { Ack, LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { AppState, ScrollView, Text, TextInput, View } from "react-native";
import { DiffReview } from "../components/DiffReview";
import { Markdown } from "../components/Markdown";
import { ToolOperations } from "../components/ToolOperations";
import { ago, mayStillBeOpen } from "../model";
import { BackBar, Banner, Button, buzz, Choices, color, space, styles, Title } from "../ui";
import { type SessionRow, TOOL_LABEL } from "./SessionsList";

type Message = NonNullable<Ack["messages"]>[number];

/** One session: its conversation, and a box to carry it on from the phone. */
export function SessionScreen({
  session,
  client,
  status,
  onBack,
  onOpenTask,
  onWatchScreen,
  say,
}: {
  session: SessionRow;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
  onWatchScreen: () => void;
  say: (message: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>();
  const [problem, setProblem] = useState<string>();
  const [readProblem, setReadProblem] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [target, setTarget] = useState<"desktop" | "agent">("desktop");
  const [refresh, setRefresh] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [review, setReview] = useState<string>();
  const [reviewProblem, setReviewProblem] = useState<string>();
  const [delivery, setDelivery] = useState<string>();
  const [deliveryHistory, setDeliveryHistory] = useState<string>();
  const [checkedAt, setCheckedAt] = useState<number>();
  const [recording, setRecording] = useState<Ack["recording"]>();
  const cursorConnected =
    session.tool === "cursor" && session.source === "editor" && session.how === "bridge";
  const codexQueue = session.tool === "codex" && session.desktop === "codex-queue";
  const desktopConnected = cursorConnected || codexQueue;
  // The last few messages are what you need to carry on; the rest on request.
  const [everything, setEverything] = useState(false);
  const hidden = messages && !everything ? Math.max(0, messages.length - 4) : 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads persisted receipts after sending
  useEffect(() => {
    if (!codexQueue || !client || status !== "online") return;
    let closed = false;
    void client
      .sessionDelivery(session.tool, session.id)
      .then((ack) => {
        if (!closed && ack.ok) setDeliveryHistory(ack.result);
      })
      .catch(() => {});
    return () => {
      closed = true;
    };
  }, [client, status, codexQueue, session.tool, session.id, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh reloads the conversation on request
  useEffect(() => {
    if (!client || status !== "online") return;
    let closed = false;
    let busy = false;
    const load = async () => {
      if (closed || busy || AppState.currentState !== "active") return;
      busy = true;
      try {
        const ack = await client.readSession(session.tool, session.id);
        if (closed) return;
        if (ack.ok) {
          setMessages(ack.messages ?? []);
          setCheckedAt(Date.now());
          setReadProblem(undefined);
          if (session.recorded) {
            const detail = await client.inspectSession(session.tool, session.id);
            if (!closed && detail.ok) setRecording(detail.recording);
          }
        } else setReadProblem(ack.error ?? "Couldn't read it.");
      } catch {
        if (!closed) setReadProblem("Couldn't reach the computer.");
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = desktopConnected ? setInterval(() => void load(), 3000) : undefined;
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      closed = true;
      clearInterval(timer);
      foreground.remove();
    };
  }, [client, status, session.tool, session.id, session.recorded, desktopConnected, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reviewVersion explicitly refreshes the snapshot
  useEffect(() => {
    if (!reviewOpen) return;
    let closed = false;
    setReview(undefined);
    setReviewProblem(undefined);
    if (!client || status !== "online") {
      setReviewProblem("Reconnect to the computer to review current changes.");
      return;
    }
    void client
      .sessionChanges(session.tool, session.id)
      .then((ack) => {
        if (closed) return;
        if (ack.ok) setReview(ack.result ?? "No review returned.");
        else setReviewProblem(ack.error ?? "Couldn't read workspace changes.");
      })
      .catch(() => {
        if (!closed) setReviewProblem("Couldn't reach the computer.");
      });
    return () => {
      closed = true;
    };
  }, [client, status, session.tool, session.id, reviewOpen, reviewVersion]);

  const send = async () => {
    if (!client || !text.trim()) return;
    setSending(true);
    setDelivery("Sending to the computer…");
    setProblem(undefined);
    try {
      const ack = await client.continueSession(session.tool, session.id, text.trim(), target);
      if (!ack.ok) {
        setDelivery("Delivery was not confirmed. Check the desktop chat before sending again.");
        setProblem(ack.error ?? "The computer couldn't continue it.");
        return;
      }
      buzz();
      setDelivery(ack.result ?? "The computer accepted the message; a reply is not yet verified.");
      setRefresh((n) => n + 1);
      say(ack.result ?? "Sent.");
      if (ack.task_id) onOpenTask(ack.task_id);
      else setText("");
    } catch {
      setDelivery(
        "Delivery is uncertain. Check the desktop chat before sending again; do not automatically repeat it.",
      );
      setProblem("Couldn't reach the computer.");
    } finally {
      setSending(false);
    }
  };

  const action =
    target === "desktop"
      ? codexQueue
        ? "Queue in Codex conversation"
        : "Send to desktop conversation"
      : session.how === "resume"
        ? "Continue"
        : session.how === "bridge"
          ? "Start CLI from this history"
          : "Continue as a new session";
  const explain =
    target === "desktop"
      ? codexQueue
        ? "Your message is queued for this same Codex conversation. Keep that chat open in Codex desktop; this transcript refreshes while the phone is active. Native approvals and edit review are not connected."
        : cursorConnected
          ? "Messages go to this existing Cursor desktop chat. The conversation refreshes here; use the computer screen for its native approvals and edit review."
          : "This conversation can be read here. Sending messages, answering native approvals, and reviewing edits in this desktop app need the computer screen; a direct desktop connection isn't available."
      : session.how === "resume"
        ? `${TOOL_LABEL[session.tool]} picks this conversation up where it left off.`
        : session.how === "bridge"
          ? "A new Cursor CLI session receives the recent history from this desktop chat."
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
      <Button
        title="Refresh conversation"
        kind="plain"
        disabled={status !== "online"}
        onPress={() => setRefresh((n) => n + 1)}
      />

      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {readProblem ? <Banner tone="warn">{readProblem}</Banner> : null}
      {delivery ? <Banner tone="info">{delivery}</Banner> : null}
      {deliveryHistory ? <Text style={styles.muted}>{deliveryHistory}</Text> : null}
      <Text style={styles.meta}>
        {status !== "online"
          ? "Disconnected · showing the last snapshot"
          : checkedAt
            ? `Transcript checked ${ago(new Date(checkedAt).toISOString())}. This does not prove the desktop is working or waiting.`
            : "Checking transcript…"}
      </Text>
      {!messages && !problem ? <Text style={styles.muted}>Loading the conversation…</Text> : null}
      {messages?.length === 0 ? (
        <Text style={styles.muted}>No messages could be read from this session.</Text>
      ) : null}
      {hidden > 0 ? (
        <Button
          title={`Show ${hidden} earlier message${hidden === 1 ? "" : "s"}`}
          kind="ghost"
          onPress={() => setEverything(true)}
        />
      ) : null}
      {messages?.slice(hidden).map((m, i) =>
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

      {recording ? (
        <View style={{ gap: space.sm, marginTop: space.md }}>
          <Text style={styles.eyebrow}>Recorded native operations</Text>
          <Text style={styles.muted}>
            Saved rollout snapshot: last recorded turn {recording.recorded_state}. This is not
            verified live desktop status. Unanswered calls here are not actionable approvals.
          </Text>
          <ToolOperations operations={recording.operations} recorded />
        </View>
      ) : null}
      <View style={{ gap: space.sm, marginTop: space.md }}>
        <Text style={styles.eyebrow}>Workspace review</Text>
        <Text style={styles.muted}>
          Current tracked edits in this conversation's folder. They may include your edits or
          another chat's work. Reviewing does not accept, reject or commit changes.
        </Text>
        <Button
          title={reviewOpen ? "Refresh workspace changes" : "View workspace changes"}
          kind="plain"
          disabled={status !== "online" || !session.folder}
          onPress={() => {
            setReviewOpen(true);
            setReviewVersion((n) => n + 1);
          }}
        />
        {reviewOpen ? (
          <>
            {reviewProblem ? (
              <Banner tone="warn">{reviewProblem}</Banner>
            ) : review ? (
              <DiffReview text={review} />
            ) : (
              <Text style={styles.body}>Reading workspace changes…</Text>
            )}
            <Button
              title="Close workspace review"
              kind="plain"
              onPress={() => setReviewOpen(false)}
            />
          </>
        ) : null}
      </View>

      <View style={{ gap: space.sm, marginTop: space.md }}>
        <Text style={styles.eyebrow}>Carry on</Text>
        <Choices
          options={[
            { value: "desktop", label: "Desktop app" },
            { value: "agent", label: "CLI agent" },
          ]}
          value={target}
          onChange={setTarget}
        />
        <Text style={styles.muted}>{explain}</Text>
        <Button
          title="Open computer screen"
          kind="plain"
          onPress={onWatchScreen}
          disabled={status !== "online"}
        />
        {recent && target === "agent" && session.how === "resume" ? (
          <Banner tone="info">
            Used {ago(new Date(session.updated_at).toISOString())}. If it's still open on your
            computer, close it there first, or the two will get mixed up.
          </Banner>
        ) : null}
        {target === "agent" || desktopConnected ? (
          <>
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
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
