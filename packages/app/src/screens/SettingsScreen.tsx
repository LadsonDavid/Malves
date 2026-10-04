import type { AgentInfo, LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { ago, type Model, running } from "../model";
import { PushCard } from "../PushCard";
import { Banner, Button, buzz, Card, Chip, Section, styles, type Tone } from "../ui";

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
      <Text style={styles.title}>Settings</Text>

      <Section title="Computer">
        <Card>
          <Text style={[styles.body, { fontWeight: "600" }]}>
            {model.computer ?? "Your computer"}
          </Text>
          <Text style={styles.muted}>
            {status === "online"
              ? "Connected, end-to-end encrypted."
              : status === "offline"
                ? `Offline${lastOnline ? ` — last seen ${ago(new Date(lastOnline).toISOString())}` : ""}. Retrying.`
                : status === "connecting"
                  ? "Connecting…"
                  : "This computer no longer accepts this phone."}
          </Text>
        </Card>
      </Section>

      <Section title="Notifications">
        <PushCard link={model.push} />
      </Section>

      <Section title="Chrome">
        <Card>
          {model.chrome === null ? (
            <Text style={styles.muted}>Unknown until the computer is connected.</Text>
          ) : model.chrome ? (
            <Text style={styles.body}>Connected — agents can use the tab you have open.</Text>
          ) : (
            <>
              <Text style={styles.body}>Not connected — browser tasks won't work.</Text>
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
              <Text style={[styles.body, { fontWeight: "600" }]}>{a.label}</Text>
              <Chip label={AGENT_STATE[a.state][0]} tone={AGENT_STATE[a.state][1]} />
            </View>
            {a.metered ? <Text style={styles.muted}>Free models, metered by malves.</Text> : null}
            {a.hint ? <Text style={styles.muted}>{a.hint}</Text> : null}
          </Card>
        ))}
        <Button
          title="I've signed in — check again"
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
