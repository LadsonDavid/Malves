import type { AgentInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { Alert, BackHandler, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { Speaker } from "../icons";
import { ago, type Model, running } from "../model";
import { PushCard } from "../PushCard";
import {
  BackBar,
  Banner,
  Button,
  buzz,
  Card,
  Chip,
  Choices,
  List,
  Row,
  Section,
  styles,
  Title,
  type Tone,
} from "../ui";
import { type Lang, voicesFor } from "../voice/engine";
import { useVoice } from "../voice/VoiceProvider";

type Props = {
  model: Model;
  status: LinkStatus;
  lastOnline: number | undefined;
  client: LinkClient | undefined;
  onUnpair: () => void;
  say: (message: string) => void;
};

const AGENT_STATE: Record<AgentInfo["state"], [string, Tone | "plain"]> = {
  ready: ["Ready", "ok"],
  checking: ["Checking…", "plain"],
  needs_sign_in: ["Needs sign-in", "warn"],
  unavailable: ["Not available", "bad"],
};

/** Everything about the connection and the computer, plus the rare, serious actions. */
type Page = "voice" | "calls" | "memory" | "computer" | "notifications";

export function SettingsScreen({ model, status, lastOnline, client, onUnpair, say }: Props) {
  const [checking, setChecking] = useState(false);
  // Settings is a short list; each row opens its own page.
  const [page, setPage] = useState<Page>();
  // Android's back button closes a sub-page first.
  useEffect(() => {
    if (!page) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      setPage(undefined);
      return true;
    });
    return () => sub.remove();
  }, [page]);
  const [stopping, setStopping] = useState(false);
  const active = running(model);
  const voice = useVoice();
  const [phoneVoices, setPhoneVoices] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void voicesFor(voice.settings.lang).then(setPhoneVoices);
  }, [voice.settings.lang]);

  const checkAgain = async () => {
    if (!client) return;
    setChecking(true);
    await client.checkAgents().catch(() => {});
    setChecking(false);
  };

  // Breakglass (§8): stopping everything is one tap away, behind one confirmation.
  const stopAll = () =>
    Alert.alert(
      `Stop all ${active.length} running task${active.length === 1 ? "" : "s"}?`,
      "Every agent stops at once. Anything already changed stays.",
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Stop all",
          style: "destructive",
          onPress: () => {
            if (!client) return;
            setStopping(true);
            void client
              .stopAll()
              .then((ack) => {
                if (ack.ok) {
                  buzz();
                  say("All tasks stopped");
                } else say(ack.error ?? "The computer couldn't stop them.");
              })
              .catch(() => say("Couldn't reach the computer."))
              .finally(() => setStopping(false));
          },
        },
      ],
    );

  const unpair = () =>
    Alert.alert(
      "Unpair this phone?",
      "It forgets this computer. To use malves again you'll need to scan a new pairing code at the computer.",
      [
        { text: "Keep paired", style: "cancel" },
        { text: "Unpair", style: "destructive", onPress: onUnpair },
      ],
    );

  if (page) {
    const titles: Record<Page, string> = {
      voice: "Voice",
      calls: "Calls",
      memory: "Memory",
      computer: "This computer",
      notifications: "Notifications",
    };
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <BackBar onBack={() => setPage(undefined)} />
        <Title>{titles[page]}</Title>
        {page === "voice" ? <VoiceCard voice={voice} phoneVoices={phoneVoices} /> : null}
        {page === "calls" ? <CallsCard voice={voice} /> : null}
        {page === "memory" ? (
          <MemoryCard model={model} client={client} online={status === "online"} say={say} />
        ) : null}
        {page === "computer" ? (
          <>
            <Card>
              <Text style={[styles.body, styles.strong]}>{model.computer ?? "Your computer"}</Text>
              <Text style={styles.muted}>
                {status === "online"
                  ? "Connected, end-to-end encrypted."
                  : status === "offline"
                    ? `Offline${lastOnline ? `, last seen ${ago(new Date(lastOnline).toISOString())}` : ""}. Retrying.`
                    : status === "connecting"
                      ? "Connecting…"
                      : "This computer no longer accepts this phone."}
              </Text>
              <Text style={styles.muted}>
                Chrome:{" "}
                {model.chrome === null
                  ? "unknown"
                  : model.chrome
                    ? "connected"
                    : "not connected (type extension in malves serve)"}
              </Text>
              <Text style={styles.muted}>
                Projects:{" "}
                {model.workspaces.map((w) => w.name).join(", ") || "none yet (type add <folder>)"}
              </Text>
            </Card>
            <List>
              {model.agents.map((a) => (
                <Row key={a.name}>
                  <View
                    style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}
                  >
                    <Text style={styles.body}>{a.label}</Text>
                    <Chip label={AGENT_STATE[a.state][0]} tone={AGENT_STATE[a.state][1]} />
                  </View>
                  {a.hint ? <Text style={styles.muted}>{a.hint}</Text> : null}
                </Row>
              ))}
            </List>
            <Button
              title="Check again"
              kind="plain"
              busy={checking}
              disabled={!client || status !== "online"}
              onPress={() => void checkAgain()}
            />
          </>
        ) : null}
        {page === "notifications" ? <PushCard link={model.push} /> : null}
      </ScrollView>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={checking} onRefresh={() => void checkAgain()} />}
    >
      <Title>Settings</Title>

      <List>
        {[
          ...(model.assistant
            ? ([
                [
                  "voice",
                  "Voice",
                  voice.settings.naturalVoices.en.includes("female") ? "Female" : "Male",
                ],
                ["calls", "Calls", voice.callsProblem ? "Not set up" : "On"],
              ] as const)
            : []),
          ["memory", "Memory", ""],
          ["computer", "This computer", status === "online" ? "Connected" : "Offline"],
          ["notifications", "Notifications", model.push ? "" : "Off"],
        ].map(([key, label, value]) => (
          <Row key={key} onPress={() => setPage(key as Page)} label={label}>
            <View style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}>
              <Text style={styles.body}>{label}</Text>
              {value ? <Text style={styles.meta}>{value}</Text> : null}
            </View>
          </Row>
        ))}
      </List>

      <Section title="Careful">
        <Button
          title={
            active.length > 0
              ? `Stop all running tasks (${active.length})`
              : "Stop all running tasks"
          }
          kind="danger"
          busy={stopping}
          disabled={active.length === 0 || !client}
          onPress={stopAll}
        />
        <Button title="Unpair this phone" kind="plain" onPress={unpair} />
      </Section>
    </ScrollView>
  );
}

type Memory = NonNullable<Awaited<ReturnType<LinkClient["memoryList"]>>["memories"]>[number];

/** What Malves remembers about you, from its notes on the computer; anything can be deleted. */
function MemoryCard({
  model,
  client,
  online,
  say,
}: {
  model: Model;
  client: LinkClient | undefined;
  online: boolean;
  say: (message: string) => void;
}) {
  const [memories, setMemories] = useState<Memory[]>();
  const [loading, setLoading] = useState(false);

  if (!model.assistant) {
    return (
      <Card>
        <Text style={styles.muted}>
          Malves isn't set up on the computer. Set MALVES_MODELS_URL, MALVES_MODELS_KEY and
          MALVES_VAULT in .env, then restart malves serve.
        </Text>
      </Card>
    );
  }

  const load = async () => {
    if (!client) return;
    setLoading(true);
    try {
      const ack = await client.memoryList();
      if (ack.ok) setMemories(ack.memories ?? []);
      else say(ack.error ?? "Couldn't load the memories.");
    } catch {
      say("Couldn't reach the computer.");
    } finally {
      setLoading(false);
    }
  };

  const forget = (m: Memory) =>
    Alert.alert("Forget this?", m.text, [
      { text: "Keep", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => {
          if (!client) return;
          void client
            .memoryForget(m.id)
            .then((ack) => {
              if (ack.ok) setMemories((list) => list?.filter((x) => x.id !== m.id));
              else say(ack.error ?? "Couldn't forget it.");
            })
            .catch(() => say("Couldn't reach the computer."));
        },
      },
    ]);

  return (
    <Card>
      <Text style={[styles.body, styles.strong]}>Memory</Text>
      <Text style={styles.muted}>What Malves remembers about you. Delete anything here.</Text>
      {memories?.length === 0 ? <Text style={styles.body}>Nothing remembered yet.</Text> : null}
      {memories?.map((m) => (
        <View
          key={m.id}
          style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.body}>{m.text}</Text>
            <Text style={styles.muted}>
              {m.kind} · since {m.since.slice(0, 10)}
            </Text>
          </View>
          <Button title="Forget" kind="plain" onPress={() => forget(m)} />
        </View>
      ))}
      <Button
        title={memories ? "Refresh" : "Show what Malves remembers"}
        kind="plain"
        busy={loading}
        disabled={!client || !online}
        onPress={() => void load()}
      />
    </Card>
  );
}

/** Malves can ring this phone ("call me when Codex finishes"); a test call checks it works. */
function CallsCard({ voice }: { voice: ReturnType<typeof useVoice> }) {
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <Text style={[styles.body, styles.strong]}>Calls</Text>
      {voice.callsProblem ? (
        <Banner tone="warn">{voice.callsProblem}</Banner>
      ) : (
        <Text style={styles.muted}>Say "call me when Codex finishes" and your phone rings.</Text>
      )}
      <View style={styles.row}>
        <Button
          title={busy ? "Calling…" : "Test call"}
          kind="plain"
          busy={busy}
          disabled={!!voice.callsProblem}
          onPress={() => {
            setBusy(true);
            void voice
              .testCall()
              .then(setResult)
              .finally(() => setBusy(false));
          }}
        />
        <Button
          title="Not ringing?"
          kind="ghost"
          onPress={() => void Linking.openSettings()}
          hint="Allow full-screen notifications for malves in Android settings"
        />
      </View>
      {result ? <Text style={styles.meta}>{result}</Text> : null}
    </Card>
  );
}

/**
 * How Malves sounds: the language you speak and a male or female voice; the
 * rest waits behind "More voice options".
 */
function VoiceCard({
  voice,
  phoneVoices,
}: {
  voice: ReturnType<typeof useVoice>;
  phoneVoices: Array<{ id: string; name: string }>;
}) {
  const [more, setMore] = useState(false);
  const s = voice.settings;
  const set = (next: Partial<typeof s>) => voice.setSettings({ ...s, ...next });
  const gender = s.naturalVoices.en.includes("female") ? "female" : "male";
  return (
    <Card>
      <Text style={[styles.body, styles.strong]}>Voice</Text>
      <Text style={styles.muted}>You speak</Text>
      <Choices<Lang>
        options={[
          { value: "en-IN", label: "English (India)" },
          { value: "en-US", label: "English (US)" },
          { value: "ta-IN", label: "தமிழ்" },
        ]}
        value={s.lang}
        onChange={(lang) => set({ lang })}
      />
      <Text style={styles.muted}>Malves' voice</Text>
      <Choices<"male" | "female">
        options={[
          { value: "male", label: "Male" },
          { value: "female", label: "Female" },
        ]}
        value={gender}
        onChange={(g) =>
          set({
            naturalVoices:
              g === "female"
                ? { ta: "ta-female", en: "en-female-1" }
                : { ta: "ta-male", en: "en-male-1" },
          })
        }
      />
      <Button
        title="Hear it"
        icon={Speaker}
        kind="plain"
        onPress={() =>
          voice.readAloud(
            s.lang === "ta-IN"
              ? "வணக்கம். நான் Malves. என்ன செய்யலாம்?"
              : "Hi, Malves here. What are we building today?",
          )
        }
      />
      <Button
        title={more ? "Fewer options" : "More voice options"}
        kind="ghost"
        onPress={() => setMore((m) => !m)}
      />
      {more ? (
        <>
          <Text style={styles.muted}>Use the phone's voice</Text>
          <Choices<"off" | "on">
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            value={s.natural ? "off" : "on"}
            onChange={(v) => set({ natural: v === "off" })}
          />
          {!s.natural && phoneVoices.length > 1 ? (
            <Choices<string>
              options={[
                { value: "", label: "Phone default" },
                ...phoneVoices
                  .slice(0, 6)
                  .map((v, i) => ({ value: v.id, label: `Voice ${i + 1}` })),
              ]}
              value={s.voices[s.lang] ?? ""}
              onChange={(id) => set({ voices: { ...s.voices, [s.lang]: id || undefined } })}
            />
          ) : null}
          <Text style={styles.muted}>Talking over Malves stops it</Text>
          <Choices<"on" | "off">
            options={[
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
            value={s.bargeIn ? "on" : "off"}
            onChange={(v) => set({ bargeIn: v === "on" })}
          />
          <Text style={styles.muted}>Dictation</Text>
          <Choices<"fast" | "precise">
            options={[
              { value: "fast", label: "Fast" },
              { value: "precise", label: "Precise (Whisper)" },
            ]}
            value={s.precise ? "precise" : "fast"}
            onChange={(v) => set({ precise: v === "precise" })}
          />
        </>
      ) : null}
    </Card>
  );
}
