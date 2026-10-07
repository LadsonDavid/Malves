import { Fraunces_300Light, Fraunces_400Regular } from "@expo-google-fonts/fraunces";
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold } from "@expo-google-fonts/geist";
import { GeistMono_400Regular, GeistMono_500Medium } from "@expo-google-fonts/geist-mono";
import { generateKeyPair, type KeyPair, type PairingOffer } from "@malves/protocol";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackHandler,
  Linking,
  Platform,
  ScrollView,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { type Tab, TabBar } from "./src/components/TabBar";
import { needsYou, parseLink, running, type Target } from "./src/model";
import { HomeScreen } from "./src/screens/HomeScreen";
import { IdeScreen } from "./src/screens/IdeScreen";
import { LeadsScreen } from "./src/screens/LeadsScreen";
import { MalvesScreen } from "./src/screens/MalvesScreen";
import { NewTaskScreen } from "./src/screens/NewTaskScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { ScreenScreen } from "./src/screens/ScreenScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { TaskScreen } from "./src/screens/TaskScreen";
import { TasksScreen } from "./src/screens/TasksScreen";
import { forgetPairing, loadPairing, type Pairing, savePairing } from "./src/storage";
import { applyScheme, Button, color, font, isDark, styles } from "./src/ui";
import { type Connection, useLink } from "./src/useLink";
import { VoiceProvider } from "./src/voice/VoiceProvider";

type Screen = "loading" | "pair" | "pairing" | "app";
/** Screens shown on top of the tabs; Back closes the top one. */
type Overlay =
  | { kind: "new" }
  | { kind: "task"; id: string }
  | { kind: "ide"; id: string }
  | { kind: "malves" }
  | { kind: "screen" };

/** e.g. "Pixel 8" — shown in `devices` on the computer. */
function phoneName(): string {
  const model = (Platform.constants as { Model?: string }).Model;
  return model && model.length <= 100 ? model : "Android phone";
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const insets = useSafeAreaInsets();
  const [fontsReady] = useFonts({
    [font.sans]: Geist_400Regular,
    [font.medium]: Geist_500Medium,
    [font.semibold]: Geist_600SemiBold,
    [font.mono]: GeistMono_400Regular,
    [font.monoMedium]: GeistMono_500Medium,
    [font.display]: Fraunces_400Regular,
    [font.displayLight]: Fraunces_300Light,
  });
  // Follows the phone live: colours change in place, then the screens below re-mount (keyed).
  const scheme = useColorScheme();
  applyScheme(scheme);
  const [screen, setScreen] = useState<Screen>("loading");
  const [tab, setTab] = useState<Tab>("home");
  const [stack, setStack] = useState<Overlay[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pairError, setPairError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** Suggested again next time, if it's still ready. */
  const [lastAgent, setLastAgent] = useState<string>();
  /** Set while pairing; saved only once the computer has accepted us. */
  const pending = useRef<{ offer: PairingOffer; keys: KeyPair }>(undefined);

  useEffect(() => {
    void loadPairing().then((saved) => {
      if (!saved) return setScreen("pair");
      setConnection({ url: saved.url, runnerKey: saved.runnerKey, keys: saved.keys });
      setScreen("app");
    });
  }, []);

  const onWelcome = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = undefined;
    const saved: Pairing = {
      url: p.offer.url,
      runnerKey: p.offer.runner,
      computer: p.offer.computer,
      keys: p.keys,
    };
    void savePairing(saved);
    setScreen("app");
  }, []);

  const link = useLink(connection, onWelcome);

  // A refused pairing (wrong or expired code) goes back to the scanner.
  useEffect(() => {
    if (link.status !== "rejected" || !pending.current) return;
    pending.current = undefined;
    setConnection(null);
    setPairError(link.detail ?? "The computer refused the pairing code.");
    setScreen("pair");
  }, [link.status, link.detail]);

  // A short message at the bottom, e.g. "Reply sent". Gone after a few seconds.
  const say = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const open = useCallback((overlay: Overlay) => setStack((s) => [...s, overlay]), []);
  const openTask = useCallback((id: string) => open({ kind: "task", id }), [open]);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);

  // Android's back button: close the top screen, then go to Home, then leave the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (stack.length > 0) {
        back();
        return true;
      }
      if (screen === "app" && tab !== "home") {
        setTab("home");
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [stack.length, screen, tab, back]);

  // Tapping a notification opens malves at that task (or Leads).
  const go = useCallback((target: Target) => {
    if (!target) return;
    if ("tab" in target) {
      setStack([]);
      setTab(target.tab);
    } else setStack([{ kind: "task", id: target.taskId }]);
  }, []);
  useEffect(() => {
    void Linking.getInitialURL().then((url) => go(parseLink(url)));
    const sub = Linking.addEventListener("url", ({ url }) => go(parseLink(url)));
    return () => sub.remove();
  }, [go]);

  const startPairing = (offer: PairingOffer) => {
    const keys = generateKeyPair();
    pending.current = { offer, keys };
    setPairError(undefined);
    setConnection({
      url: offer.url,
      runnerKey: offer.runner,
      keys,
      pair: { code: offer.code, name: phoneName() },
    });
    setScreen("pairing");
  };

  const unpair = () => {
    pending.current = undefined;
    void forgetPairing();
    setConnection(null);
    setStack([]);
    setTab("home");
    setScreen("pair");
  };

  const top = stack.at(-1);
  const { model, status, client } = link;

  const content =
    screen === "loading" || !fontsReady ? null : screen === "pair" ? (
      <PairScreen error={pairError} onOffer={startPairing} />
    ) : screen === "pairing" ? (
      <ScrollView contentContainerStyle={styles.page}>
        <Text style={styles.title}>Connecting…</Text>
        <Text style={styles.body}>
          Pairing with {pending.current?.offer.computer ?? "your computer"}. Your phone needs to
          reach it: Tailscale on both (works anywhere), or the same Wi-Fi.
        </Text>
        <Text style={styles.muted}>Status: {status}</Text>
        <Button title="Cancel" kind="plain" onPress={unpair} />
      </ScrollView>
    ) : top?.kind === "new" ? (
      <NewTaskScreen
        model={model}
        client={client}
        lastAgent={lastAgent}
        onCreated={setLastAgent}
        onClose={back}
        status={status}
        onOpenTask={(id) => setStack((s) => [...s.slice(0, -1), { kind: "task", id }])}
        say={say}
      />
    ) : top?.kind === "task" ? (
      <TaskScreen
        key={top.id}
        taskId={top.id}
        model={model}
        client={client}
        status={status}
        onBack={back}
        onOpenTask={(id) => setStack((s) => [...s.slice(0, -1), { kind: "task", id }])}
        say={say}
      />
    ) : top?.kind === "screen" ? (
      <ScreenScreen model={model} client={client} status={status} onBack={back} />
    ) : top?.kind === "malves" ? (
      <MalvesScreen onBack={back} />
    ) : top?.kind === "ide" ? (
      <IdeScreen
        key={top.id}
        ideId={top.id}
        model={model}
        client={client}
        status={status}
        onBack={back}
        onOpenTask={openTask}
        say={say}
      />
    ) : tab === "tasks" ? (
      <TasksScreen model={model} client={client} onOpenTask={openTask} />
    ) : tab === "leads" ? (
      <LeadsScreen model={model} client={client} lastAgent={lastAgent} onOpenTask={openTask} />
    ) : tab === "settings" ? (
      <SettingsScreen
        model={model}
        status={status}
        lastOnline={link.lastOnline}
        client={client}
        onUnpair={unpair}
        say={say}
      />
    ) : (
      <HomeScreen
        model={model}
        status={status}
        detail={link.detail}
        lastOnline={link.lastOnline}
        client={client}
        onNewTask={() => open({ kind: "new" })}
        onOpenTask={openTask}
        onAllTasks={() => setTab("tasks")}
        onOpenIde={(id) => open({ kind: "ide", id })}
        onOpenMalves={() => open({ kind: "malves" })}
        onWatchScreen={() => open({ kind: "screen" })}
        onPairAgain={unpair}
      />
    );

  return (
    <VoiceProvider model={model} client={client} status={status} lastAgent={lastAgent}>
      <View style={{ flex: 1, backgroundColor: color.page, paddingTop: insets.top }}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <View key={scheme ?? "light"} style={{ flex: 1 }}>
          {content}
        </View>
        {notice ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              position: "absolute",
              left: 16,
              right: 16,
              bottom: (screen === "app" && !top ? 64 : 16) + insets.bottom,
              backgroundColor: color.zone,
              borderRadius: 12,
              padding: 14,
            }}
          >
            <Text style={{ color: color.zoneText, fontFamily: font.sans, fontSize: 15 }}>
              {notice}
            </Text>
          </View>
        ) : null}
        {screen === "app" && !top ? (
          <TabBar
            current={tab}
            onChange={(t) => setTab(t)}
            badges={{ home: needsYou(model).length, tasks: running(model).length }}
            bottomInset={insets.bottom}
          />
        ) : (
          <View style={{ height: insets.bottom }} />
        )}
      </View>
    </VoiceProvider>
  );
}
