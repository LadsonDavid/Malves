import type { AgentInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Speaker } from "../icons";
import { ago, type Model, running } from "../model";
import { PushCard } from "../PushCard";
import {
  Banner,
  Button,
  buzz,
  Card,
  Chip,
  Choices,
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
export function SettingsScreen({ model, status, lastOnline, client, onUnpair, say }: Props) {
  const [checking, setChecking] = useState(false);
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

  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={<RefreshControl refreshing={checking} onRefresh={() => void checkAgain()} />}
    >
      <Title>Settings</Title>

      <Section title="Computer">
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
        </Card>
      </Section>

      <Section title="Notifications">
        <PushCard link={model.push} />
      </Section>

      <Section title="Voice">
        <Card>
          <Text style={styles.muted}>Language you speak</Text>
          <Choices<Lang>
            options={[
              { value: "en-IN", label: "English (India)" },
              { value: "en-US", label: "English (US)" },
              { value: "ta-IN", label: "தமிழ்" },
            ]}
            value={voice.settings.lang}
            onChange={(lang) => voice.setSettings({ ...voice.settings, lang })}
          />
          {phoneVoices.length > 1 ? (
            <>
              <Text style={styles.muted}>Malves' voice (from your phone)</Text>
              <Choices<string>
                options={[
                  { value: "", label: "Phone default" },
                  ...phoneVoices.slice(0, 8).map((v, i) => ({
                    value: v.id,
                    label: `Voice ${i + 1}${/network/i.test(v.id) ? " (online)" : ""}`,
                  })),
                ]}
                value={voice.settings.voices[voice.settings.lang] ?? ""}
                onChange={(id) =>
                  voice.setSettings({
                    ...voice.settings,
                    voices: { ...voice.settings.voices, [voice.settings.lang]: id || undefined },
                  })
                }
              />
            </>
          ) : null}
          <Text style={styles.muted}>Dictation accuracy</Text>
          <Choices<"fast" | "precise">
            options={[
              { value: "fast", label: "Fast (live)" },
              { value: "precise", label: "Precise (Whisper)" },
            ]}
            value={voice.settings.precise ? "precise" : "fast"}
            onChange={(v) => voice.setSettings({ ...voice.settings, precise: v === "precise" })}
          />
          {voice.settings.precise && !voice.canBePrecise ? (
            <Text style={styles.muted}>
              Precise mode needs Android 13+ and freellmapi on the computer (MALVES_MODELS_URL and
              MALVES_MODELS_KEY). Until then, dictation uses the fast mode.
            </Text>
          ) : (
            <Text style={styles.muted}>
              Precise mode sends your recording to Whisper through your freellmapi, after you finish
              talking. Commands and answers always use the fast mode.
            </Text>
          )}
          {!voice.canListen ? (
            <Text style={styles.muted}>
              Listening needs the malves app (APK); Expo Go can only read aloud.
            </Text>
          ) : null}
          <Button
            title="Test the voice"
            icon={Speaker}
            kind="plain"
            onPress={() =>
              voice.readAloud(
                voice.settings.lang === "ta-IN"
                  ? "வணக்கம் Ladson. நான் Malves. என்ன செய்யலாம்?"
                  : "Hi Ladson, Malves here. What are we building today?",
              )
            }
          />
        </Card>
      </Section>

      <Section title="Malves' memory">
        <MemoryCard model={model} client={client} online={status === "online"} say={say} />
      </Section>

      <Section title="Chrome">
        <Card>
          {model.chrome === null ? (
            <Text style={styles.muted}>Unknown until the computer is connected.</Text>
          ) : model.chrome ? (
            <Text style={styles.body}>Connected. Agents can use the tab you have open.</Text>
          ) : (
            <>
              <Text style={styles.body}>Not connected. Browser tasks won't work.</Text>
              <Text style={styles.muted}>
                On the computer, in malves serve, type extension and follow the steps.
              </Text>
            </>
          )}
        </Card>
      </Section>

      <Section title="Agents">
        {model.agents.map((a) => (
          <Card key={a.name}>
            <View style={[styles.row, { alignItems: "center", justifyContent: "space-between" }]}>
              <Text style={[styles.body, styles.strong]}>{a.label}</Text>
              <Chip label={AGENT_STATE[a.state][0]} tone={AGENT_STATE[a.state][1]} />
            </View>
            {a.metered ? <Text style={styles.muted}>Free models, metered by malves.</Text> : null}
            {a.hint ? <Text style={styles.muted}>{a.hint}</Text> : null}
          </Card>
        ))}
        <Button
          title="I've signed in, check again"
          kind="plain"
          busy={checking}
          disabled={!client || status !== "online"}
          onPress={() => void checkAgain()}
        />
      </Section>

      <Section title="Projects">
        {model.workspaces.length === 0 ? (
          <Banner tone="info">
            No project folders yet. On the computer, in malves serve, type add &lt;folder&gt;.
          </Banner>
        ) : (
          <Card>
            {model.workspaces.map((w) => (
              <Text key={w.id} style={styles.body}>
                {w.name}
              </Text>
            ))}
            <Text style={styles.muted}>To add one: on the computer, type add &lt;folder&gt;.</Text>
          </Card>
        )}
      </Section>

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
      <Text style={styles.muted}>
        Notes in your Obsidian vault on the computer. Edit them there, or delete them here.
      </Text>
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
