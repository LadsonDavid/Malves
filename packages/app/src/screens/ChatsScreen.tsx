import { type LinkClient, type LinkStatus, randomToken } from "@malves/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { watchDelta } from "../delta";
import { Mic, Plus, Refresh, Send, Trash } from "../icons";
import { watchProgress } from "../progress";
import {
  BackBar,
  Banner,
  Button,
  Chip,
  color,
  Eyebrow,
  IconButton,
  List,
  Row,
  space,
  styles,
  Title,
} from "../ui";

type Chat = NonNullable<Awaited<ReturnType<LinkClient["chatList"]>>["chats"]>[number];
type Line = NonNullable<Awaited<ReturnType<LinkClient["chatOpen"]>>["chat_lines"]>[number];

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? clock(at)
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** All chats with Malves, newest first, and the two ways to start one. */
export function ChatsScreen({
  client,
  status,
  onOpen,
}: {
  client: LinkClient | undefined;
  status: LinkStatus;
  onOpen: (id: string) => void;
}) {
  const [chats, setChats] = useState<Chat[]>();
  const [error, setError] = useState<string>();
  const online = status === "online" && client !== undefined;

  const load = useCallback(async () => {
    if (!client) return;
    const ack = await client.chatList().catch(() => undefined);
    if (!ack) return;
    if (ack.ok) {
      setChats(ack.chats ?? []);
      setError(undefined);
    } else setError(ack.error ?? "Couldn't load your chats.");
  }, [client]);

  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const start = async (temp: boolean) => {
    const ack = await client?.chatNew(temp).catch(() => undefined);
    const chat = ack?.chats?.[0];
    if (chat) onOpen(chat.id);
    else setError(ack?.error ?? "Couldn't start a chat.");
  };

  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: space.xxl }]}>
      <Title eyebrow="Talk it through">Chat</Title>
      <Text style={styles.muted}>
        Malves knows your skills, books, memory and tasks. A normal chat is remembered. A temp chat
        is not.
      </Text>
      {!online ? <Banner tone="warn">Not connected to your computer.</Banner> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button
            title="New chat"
            icon={Plus}
            disabled={!online}
            onPress={() => void start(false)}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="New temp chat"
            kind="secondary"
            disabled={!online}
            hint="A chat that is never saved or remembered"
            onPress={() => void start(true)}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Eyebrow>Your chats</Eyebrow>
        <IconButton icon={Refresh} label="Refresh" onPress={() => void load()} />
      </View>
      {chats === undefined ? (
        <Text style={styles.muted}>{online ? "Loading…" : "Connect to see your chats."}</Text>
      ) : chats.length === 0 ? (
        <Text style={styles.muted}>No chats yet. Start one above.</Text>
      ) : (
        <List>
          {chats.map((chat) => (
            <Row key={chat.id} onPress={() => onOpen(chat.id)} label={chat.title}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                  {chat.title}
                </Text>
                {chat.temp ? <Chip label="Temp" tone="info" /> : null}
                <Text style={styles.meta}>{day(chat.updated)}</Text>
              </View>
              {chat.preview ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {chat.preview}
                </Text>
              ) : null}
            </Row>
          ))}
        </List>
      )}
    </ScrollView>
  );
}

/** One chat: messages, a text box, Confirm/Cancel for read-backs, and Save for a temp chat. */
export function ChatThread({
  chatId,
  client,
  status,
  onBack,
  onVoice,
}: {
  chatId: string;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
  onVoice: () => void;
}) {
  const [meta, setMeta] = useState<Chat>();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState("");
  const [progress, setProgress] = useState("");
  const [pending, setPending] = useState<{ id: string; summary: string }>();
  const [error, setError] = useState<string>();
  const scroll = useRef<ScrollView>(null);
  const online = status === "online" && client !== undefined;

  useEffect(() => {
    if (!client || !online) return;
    let live = true;
    void client.chatOpen(chatId).then(
      (ack) => {
        if (!live) return;
        if (ack.ok) {
          setMeta(ack.chats?.[0]);
          setLines(ack.chat_lines ?? []);
        } else setError(ack.error ?? "Couldn't open this chat.");
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, online, chatId]);

  const add = (who: Line["who"], text: string) =>
    setLines((l) => [...l, { who, text, at: Date.now() }]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !client) return;
    setInput("");
    setError(undefined);
    setPending(undefined);
    setBusy(true);
    setWriting("");
    setProgress("");
    add("you", text);
    const commandId = randomToken(12);
    // The words as they are written, and "Step 2: search books" while it works.
    const stopWords = watchDelta(commandId, (piece) => setWriting((w) => w + piece));
    const stopSteps = watchProgress(commandId, setProgress);
    try {
      const ack = await client.assistantSay(
        chatId,
        text,
        [],
        false,
        commandId,
        undefined,
        undefined,
        true,
      );
      if (ack.ok && ack.assistant) {
        add("malves", ack.assistant.reply);
        setPending(ack.assistant.pending);
      } else setError(ack.error ?? "Malves didn't answer.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The message didn't go through.");
    } finally {
      stopWords();
      stopSteps();
      setWriting("");
      setProgress("");
      setBusy(false);
    }
  };

  const answer = async (yes: boolean) => {
    if (!client || !pending) return;
    const id = pending.id;
    setPending(undefined);
    setBusy(true);
    try {
      const ack = await client.assistantConfirm(chatId, id, yes);
      if (ack.ok && ack.assistant) add("malves", ack.assistant.reply);
      else setError(ack.error ?? "That didn't go through.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const ack = await client?.chatSave(chatId).catch(() => undefined);
    if (ack?.ok && ack.chats?.[0]) setMeta(ack.chats[0]);
    else setError(ack?.error ?? "Couldn't save this chat.");
  };

  const remove = () =>
    Alert.alert(
      "Delete this chat?",
      meta?.temp ? "A temp chat is gone for good." : "The chat file is deleted from your vault.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void client?.chatDelete(chatId).catch(() => {});
            onBack();
          },
        },
      ],
    );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.page }}
      behavior={Platform.OS === "android" ? "padding" : "height"}
    >
      <ScrollView
        ref={scroll}
        contentContainerStyle={[styles.page, { paddingBottom: space.lg }]}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <BackBar onBack={onBack}>
          <IconButton icon={Mic} label="Talk by voice" onPress={onVoice} />
          {meta?.temp ? (
            <Button title="Save chat" kind="secondary" onPress={() => void save()} />
          ) : null}
          <IconButton icon={Trash} label="Delete chat" onPress={remove} />
        </BackBar>
        <Title eyebrow={meta?.temp ? "Temp chat" : "Chat"}>{meta?.title ?? "Malves"}</Title>
        {meta?.temp ? (
          <Banner tone="info">
            Temp chat. Nothing here is saved or remembered. Tap Save chat to keep it.
          </Banner>
        ) : null}
        {!online ? <Banner tone="warn">Not connected to your computer.</Banner> : null}
        {lines.length === 0 && !busy ? (
          <Text style={styles.muted}>Say anything. Ask about a book, a skill, or your tasks.</Text>
        ) : null}
        {lines.map((line, i) =>
          line.who === "you" ? (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the chat only grows at the end
              key={i}
              style={{
                alignSelf: "flex-end",
                maxWidth: "85%",
                backgroundColor: color.tint,
                borderRadius: 18,
                borderBottomRightRadius: 4,
                paddingHorizontal: space.md + 2,
                paddingVertical: space.sm + 2,
              }}
            >
              <Text style={styles.body} selectable>
                {line.text}
              </Text>
            </View>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the chat only grows at the end
            <View key={i} style={{ maxWidth: "92%", gap: 2 }}>
              <Text style={styles.meta}>MALVES · {clock(line.at)}</Text>
              <Text style={styles.body} selectable>
                {line.text}
              </Text>
            </View>
          ),
        )}
        {busy ? (
          <View style={{ maxWidth: "92%", gap: 2 }}>
            <Text style={styles.meta}>MALVES</Text>
            <Text style={writing ? styles.body : styles.muted}>{writing || progress || "…"}</Text>
          </View>
        ) : null}
        {pending ? (
          <View style={{ gap: space.sm }}>
            <Banner tone="info">{pending.summary}</Banner>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Button title="Confirm" onPress={() => void answer(true)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Cancel" kind="secondary" onPress={() => void answer(false)} />
              </View>
            </View>
          </View>
        ) : null}
        {error ? <Banner tone="bad">{error}</Banner> : null}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingBottom: space.sm,
          paddingTop: space.sm,
          borderTopWidth: 1,
          borderTopColor: color.line,
        }}
      >
        <TextInput
          style={[styles.input, { flex: 1, maxHeight: 140, textAlignVertical: "top" }]}
          multiline
          placeholder="Message Malves"
          value={input}
          onChangeText={setInput}
          editable={online}
          accessibilityLabel="Message Malves"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!online || busy || !input.trim()}
          onPress={() => void send()}
          style={{
            height: 48,
            width: 48,
            borderRadius: 24,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: color.primary,
            opacity: !online || busy || !input.trim() ? 0.4 : 1,
          }}
        >
          <Send size={22} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
