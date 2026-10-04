import { Text, View } from "react-native";
import { Banner, Button, Card, color, styles } from "../ui";
import { useVoice } from "./VoiceProvider";

const PHASE_WORDS = {
  idle: "",
  speaking: "🔊 Speaking…",
  listening: "🎤 Listening…",
  working: "⏳ Working…",
};

/** Talk to malves: one turn at a time, or hands-free voice mode. */
export function VoiceBar() {
  const voice = useVoice();
  if (!voice.canListen) {
    return (
      <Text style={styles.muted}>
        🔊 Questions can be read aloud. To talk to malves, use the malves app (APK) — Expo Go can't
        listen.
      </Text>
    );
  }
  const busy = voice.phase !== "idle";
  return (
    <Card>
      <View style={[styles.row, { alignItems: "center" }]}>
        <Button
          title={busy && !voice.mode ? "■ Stop" : "🎤 Talk"}
          kind={voice.mode ? "plain" : "primary"}
          hint="Say a command, or answer the oldest question"
          onPress={busy && !voice.mode ? voice.hush : voice.talk}
          disabled={voice.mode}
        />
        <Button
          title={voice.mode ? "Voice mode: on" : "Voice mode: off"}
          kind={voice.mode ? "danger" : "plain"}
          hint="Hands-free: malves reads questions aloud and listens for your answers"
          onPress={voice.toggleMode}
        />
      </View>
      {busy ? (
        <Text
          style={[styles.body, { color: voice.phase === "listening" ? color.ok : color.muted }]}
        >
          {PHASE_WORDS[voice.phase]}
        </Text>
      ) : null}
      {voice.heard ? (
        <Text style={styles.body}>
          <Text style={{ fontWeight: "700" }}>You: </Text>
          {voice.heard}
        </Text>
      ) : null}
      {voice.said ? (
        <Text style={styles.muted} numberOfLines={3}>
          malves: {voice.said}
        </Text>
      ) : null}
      {voice.problem ? <Banner tone="bad">{voice.problem}</Banner> : null}
      {!busy && !voice.heard ? (
        <Text style={styles.muted}>
          Try: “ask Claude to fix the footer in {"<project>"}”, “what’s running?”, “allow”, “read
          the result”.
        </Text>
      ) : null}
    </Card>
  );
}
