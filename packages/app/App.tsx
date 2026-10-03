import { generateKeyPair, type KeyPair, type PairingOffer } from "@malves/protocol";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, ScrollView, Text } from "react-native";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LeadsScreen } from "./src/screens/LeadsScreen";
import { NewTaskScreen } from "./src/screens/NewTaskScreen";
import { PairScreen } from "./src/screens/PairScreen";
import { forgetPairing, loadPairing, type Pairing, savePairing } from "./src/storage";
import { Button, styles } from "./src/ui";
import { type Connection, useLink } from "./src/useLink";

type Screen = "loading" | "pair" | "pairing" | "home" | "new" | "leads";

/** e.g. "Pixel 8" — shown in `devices` on the computer. */
function phoneName(): string {
  const model = (Platform.constants as { Model?: string }).Model;
  return model && model.length <= 100 ? model : "Android phone";
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [pairError, setPairError] = useState<string>();
  /** Suggested again next time, if it's still ready. */
  const [lastAgent, setLastAgent] = useState<string>();
  /** Set while pairing; saved only once the computer has accepted us. */
  const pending = useRef<{ offer: PairingOffer; keys: KeyPair }>(undefined);

  useEffect(() => {
    void loadPairing().then((saved) => {
      if (!saved) return setScreen("pair");
      setConnection({ url: saved.url, runnerKey: saved.runnerKey, keys: saved.keys });
      setScreen("home");
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
    setScreen("home");
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
    setScreen("pair");
  };

  return (
    <>
      <StatusBar style="dark" />
      {screen === "loading" ? null : screen === "pair" ? (
        <PairScreen error={pairError} onOffer={startPairing} />
      ) : screen === "pairing" ? (
        <ScrollView contentContainerStyle={styles.page}>
          <Text style={styles.title}>Connecting…</Text>
          <Text style={styles.body}>
            Pairing with {pending.current?.offer.computer ?? "your computer"}. Your phone needs to
            reach it: same Wi-Fi, or Tailscale on both.
          </Text>
          <Text style={styles.muted}>Status: {link.status}</Text>
          <Button title="Cancel" kind="plain" onPress={unpair} />
        </ScrollView>
      ) : screen === "leads" ? (
        <LeadsScreen
          model={link.model}
          client={link.client}
          lastAgent={lastAgent}
          onClose={() => setScreen("home")}
        />
      ) : screen === "new" ? (
        <NewTaskScreen
          model={link.model}
          client={link.client}
          lastAgent={lastAgent}
          onCreated={setLastAgent}
          onClose={() => setScreen("home")}
        />
      ) : (
        <HomeScreen
          model={link.model}
          status={link.status}
          detail={link.detail}
          lastOnline={link.lastOnline}
          client={link.client}
          onNewTask={() => setScreen("new")}
          onLeads={() => setScreen("leads")}
          onUnpair={unpair}
        />
      )}
    </>
  );
}
