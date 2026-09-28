import { CameraView, useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Alert,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { type ComputerView, links, type QuestionView, type TaskView } from "./src/links";
import { enablePush, listenForRegistrations } from "./src/push";

type Screen = "inbox" | "new" | "computers" | "scan";

export default function App() {
  const state = useSyncExternalStore(links.subscribe, links.getSnapshot);
  const [screen, setScreen] = useState<Screen>("inbox");
  const colors = palette(useColorScheme() === "dark");
  const s = styles(colors);

  useEffect(() => {
    links.start().catch((e: unknown) => Alert.alert("malves", String(e)));
    listenForRegistrations();
  }, []);

  if (!state.ready) {
    return (
      <SafeAreaView style={s.screen}>
        <Text style={s.muted}>Starting…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="auto" />
      <View style={s.tabs}>
        {(
          [
            ["inbox", `Inbox${state.questions.length ? ` (${state.questions.length})` : ""}`],
            ["new", "New task"],
            ["computers", "Computers"],
          ] as const
        ).map(([id, label]) => (
          <Pressable
            key={id}
            onPress={() => setScreen(id)}
            style={[s.tab, screen === id && s.tabOn]}
          >
            <Text style={[s.tabText, screen === id && s.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {screen === "inbox" && <Inbox s={s} questions={state.questions} tasks={state.tasks} />}
      {screen === "new" && (
        <NewTask s={s} computers={state.computers} onDone={() => setScreen("inbox")} />
      )}
      {screen === "computers" && (
        <Computers s={s} computers={state.computers} onPair={() => setScreen("scan")} />
      )}
      {screen === "scan" && <Scan s={s} onDone={() => setScreen("computers")} />}
    </SafeAreaView>
  );
}

// ---- Inbox --------------------------------------------------------------------

function Inbox({ s, questions, tasks }: { s: S; questions: QuestionView[]; tasks: TaskView[] }) {
  const now = useNow();
  const active = tasks.filter((t) => !["done", "failed", "stopped"].includes(t.state));
  const today = tasks.filter(
    (t) => ["done", "failed", "stopped"].includes(t.state) && now - t.updatedAt < 24 * 3600 * 1000,
  );
  return (
    <ScrollView contentContainerStyle={s.body}>
      {questions.length === 0 && active.length === 0 && (
        <Text style={s.muted}>Nothing needs you right now.</Text>
      )}
      {questions.map((q) => (
        <QuestionCard key={`${q.runnerId}/${q.id}`} s={s} q={q} now={now} />
      ))}
      {active.length > 0 && <Text style={s.heading}>Running</Text>}
      {active.map((t) => (
        <View key={`${t.runnerId}/${t.id}`} style={s.card}>
          <Text style={s.title}>{t.prompt}</Text>
          <Text style={s.muted}>
            {t.agent} · {t.state === "waiting" ? "waiting for you" : t.state}
          </Text>
          <Pressable
            style={s.secondary}
            onPress={() =>
              links.stopTask(t).catch((e: unknown) => Alert.alert("Could not stop", String(e)))
            }
          >
            <Text style={s.secondaryText}>Stop</Text>
          </Pressable>
        </View>
      ))}
      {today.length > 0 && <Text style={s.heading}>Done today</Text>}
      {today.map((t) => (
        <View key={`${t.runnerId}/${t.id}`} style={s.card}>
          <Text style={s.title}>{t.prompt}</Text>
          <Text style={t.state === "done" ? s.good : s.bad}>
            {t.state}
            {t.reason ? ` — ${t.reason}` : ""}
          </Text>
          {t.result ? <Text style={s.text}>{t.result}</Text> : null}
        </View>
      ))}
    </ScrollView>
  );
}

function QuestionCard({ s, q, now }: { s: S; q: QuestionView; now: number }) {
  const [sending, setSending] = useState(false);
  const seconds = Math.max(0, Math.round((q.expiresAt - now) / 1000));
  const answer = async (choiceId: string) => {
    setSending(true);
    try {
      const result = await links.answer(q, choiceId);
      if (result === "closed") Alert.alert("Too late", "This question had already been closed.");
    } catch (e) {
      Alert.alert("Not sent", String(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <View style={[s.card, q.risk === "high" && s.risky]}>
      <Text style={s.muted}>
        {q.kind.replace("_", " ")} · {q.risk} risk · {seconds}s left, then the task stops
      </Text>
      <Text style={s.title}>{q.text}</Text>
      <View style={s.row}>
        {q.choices.map((c) => (
          <Pressable key={c.id} disabled={sending} style={s.primary} onPress={() => answer(c.id)}>
            <Text style={s.primaryText}>{c.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---- New task: describe, pick computer and tool, go (R4) ------------------------

function NewTask({
  s,
  computers,
  onDone,
}: {
  s: S;
  computers: ComputerView[];
  onDone: () => void;
}) {
  const online = computers.filter((c) => c.welcome);
  const [prompt, setPrompt] = useState("");
  const [runnerId, setRunnerId] = useState(online[0]?.runnerId);
  const computer = online.find((c) => c.runnerId === runnerId) ?? online[0];
  const [workspaceId, setWorkspaceId] = useState<string>();
  const [agent, setAgent] = useState<string>();
  const [browser, setBrowser] = useState(false);
  const workspaces = computer?.welcome?.workspaces ?? [];
  const agents = (computer?.welcome?.agents ?? []).filter((a) => a.available);
  const ws = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
  const tool = agents.find((a) => a.name === agent) ?? agents[0];

  if (online.length === 0) {
    return (
      <View style={s.body}>
        <Text style={s.muted}>
          No computer is reachable. Pair one, or check it's running `malves serve`.
        </Text>
      </View>
    );
  }

  const go = async () => {
    if (!computer || !ws || !tool || !prompt.trim()) return;
    try {
      await links.createTask({
        runnerId: computer.runnerId,
        workspaceId: ws.id,
        agent: tool.name,
        prompt: prompt.trim(),
        browser,
      });
      setPrompt("");
      onDone();
    } catch (e) {
      Alert.alert("Not started", String(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <TextInput
        style={s.input}
        multiline
        placeholder="What should the agent do?"
        placeholderTextColor="#888"
        value={prompt}
        onChangeText={setPrompt}
      />
      {online.length > 1 && (
        <Chips
          s={s}
          items={online.map((c) => [c.runnerId, c.name])}
          value={computer?.runnerId}
          onPick={setRunnerId}
        />
      )}
      <Chips
        s={s}
        items={workspaces.map((w) => [w.id, w.name])}
        value={ws?.id}
        onPick={setWorkspaceId}
      />
      <Chips
        s={s}
        items={agents.map((a) => [a.name, a.name])}
        value={tool?.name}
        onPick={setAgent}
      />
      <View style={s.row}>
        <Switch value={browser} onValueChange={setBrowser} />
        <Text style={s.text}>Browser (asks before submitting anything)</Text>
      </View>
      <Pressable style={[s.primary, !prompt.trim() && s.disabled]} onPress={go}>
        <Text style={s.primaryText}>Go</Text>
      </Pressable>
    </ScrollView>
  );
}

function Chips(props: {
  s: S;
  items: Array<readonly [string, string]>;
  value: string | undefined;
  onPick: (id: string) => void;
}) {
  const { s } = props;
  return (
    <View style={s.row}>
      {props.items.map(([id, label]) => (
        <Pressable
          key={id}
          onPress={() => props.onPick(id)}
          style={[s.chip, props.value === id && s.chipOn]}
        >
          <Text style={[s.chipText, props.value === id && s.chipTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---- Computers ------------------------------------------------------------------

function Computers({
  s,
  computers,
  onPair,
}: {
  s: S;
  computers: ComputerView[];
  onPair: () => void;
}) {
  const now = useNow();
  return (
    <ScrollView contentContainerStyle={s.body}>
      {computers.map((c) => (
        <View key={c.runnerId} style={s.card}>
          <Text style={s.title}>{c.name}</Text>
          <Text style={c.status.state === "online" ? s.good : s.muted}>{presence(c, now)}</Text>
          <View style={s.row}>
            <Pressable
              style={s.secondary}
              onPress={() => enablePush(c).catch((e: unknown) => Alert.alert("Push", String(e)))}
            >
              <Text style={s.secondaryText}>Notifications</Text>
            </Pressable>
            <Pressable
              style={s.secondary}
              onPress={() =>
                Alert.alert("Remove this computer?", "Pair again with a new QR code to undo.", [
                  { text: "Cancel" },
                  {
                    text: "Remove",
                    style: "destructive",
                    onPress: () => void links.removeComputer(c.runnerId),
                  },
                ])
              }
            >
              <Text style={s.secondaryText}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <Pressable style={s.primary} onPress={onPair}>
        <Text style={s.primaryText}>Pair a computer</Text>
      </Pressable>
      <Text style={s.muted}>On the computer, run `malves pair` and scan the code it shows.</Text>
    </ScrollView>
  );
}

/** "Computer offline" is shown beside tasks, not as a task state (§3). */
function presence(c: ComputerView, now: number): string {
  if (c.status.state === "online") return "online";
  const last = c.status.state === "offline" ? c.status.lastSeen : undefined;
  if (!last) return "connecting…";
  const minutes = Math.round((now - last) / 60_000);
  return minutes < 1 ? "last seen just now" : `last seen ${minutes} min ago`;
}

function Scan({ s, onDone }: { s: S; onDone: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={s.body}>
        <Text style={s.text}>The camera is needed once, to read the pairing code.</Text>
        <Pressable style={s.primary} onPress={requestPermission}>
          <Text style={s.primaryText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <CameraView
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={
        busy
          ? undefined
          : async ({ data }) => {
              setBusy(true);
              try {
                const name = String(
                  (Platform.constants as { Model?: string }).Model ?? "Android phone",
                );
                await links.addComputer(data, name);
                onDone();
              } catch (e) {
                Alert.alert("Could not pair", e instanceof Error ? e.message : String(e), [
                  { text: "OK", onPress: () => setBusy(false) },
                ]);
              }
            }
      }
    />
  );
}

// ---- bits -------------------------------------------------------------------------

function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

type Palette = ReturnType<typeof palette>;
type S = ReturnType<typeof styles>;

function palette(dark: boolean) {
  return {
    bg: dark ? "#111418" : "#f6f7f9",
    card: dark ? "#1b2027" : "#ffffff",
    text: dark ? "#e8eaed" : "#1b1f24",
    muted: dark ? "#9aa3ad" : "#5f6b76",
    accent: "#2f6fed",
    good: dark ? "#6fcf97" : "#1e8e3e",
    bad: dark ? "#f28b82" : "#c5221f",
    border: dark ? "#2c333c" : "#e1e4e8",
  };
}

function styles(c: Palette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg, paddingTop: Platform.OS === "android" ? 32 : 0 },
    body: { padding: 16, gap: 12 },
    tabs: { flexDirection: "row", paddingHorizontal: 12, gap: 8, paddingBottom: 8 },
    tab: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 16 },
    tabOn: { backgroundColor: c.accent },
    tabText: { color: c.muted, fontWeight: "600" },
    tabTextOn: { color: "#fff" },
    card: {
      backgroundColor: c.card,
      borderRadius: 12,
      padding: 14,
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
    },
    risky: { borderColor: c.bad },
    heading: { color: c.muted, fontWeight: "700", marginTop: 8 },
    title: { color: c.text, fontSize: 16, fontWeight: "600" },
    text: { color: c.text },
    muted: { color: c.muted },
    good: { color: c.good },
    bad: { color: c.bad },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    primary: {
      backgroundColor: c.accent,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 18,
      alignItems: "center",
    },
    primaryText: { color: "#fff", fontWeight: "700" },
    secondary: {
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    secondaryText: { color: c.text },
    disabled: { opacity: 0.5 },
    input: {
      backgroundColor: c.card,
      color: c.text,
      borderRadius: 10,
      padding: 12,
      minHeight: 100,
      borderWidth: 1,
      borderColor: c.border,
      textAlignVertical: "top",
    },
    chip: {
      borderRadius: 16,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
    },
    chipOn: { backgroundColor: c.accent, borderColor: c.accent },
    chipText: { color: c.text },
    chipTextOn: { color: "#fff" },
  });
}
