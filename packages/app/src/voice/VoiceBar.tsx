import { Pressable, Text, View } from "react-native";
import { Conversation, Mic, Stop } from "../icons";
import { Button, color, Eyebrow, font, IconButton, space } from "../ui";
import { useVoice } from "./VoiceProvider";

const PHASE_WORDS = {
  idle: "Ready",
  speaking: "Speaking",
  listening: "Listening",
  working: "Thinking",
};

/**
 * Malves, on the home screen: a navy zone with what it last said, a mic, and
 * hands-free mode. Its read-backs show here with Confirm and Cancel.
 */
export function VoiceBar({ onOpenConversation }: { onOpenConversation?: () => void }) {
  const voice = useVoice();
  const busy = voice.phase !== "idle";
  const state = voice.mode && !busy ? "Hands-free" : PHASE_WORDS[voice.phase];
  const live = voice.phase === "listening";

  return (
    <View
      style={{
        backgroundColor: color.zone,
        borderRadius: 18,
        padding: space.lg,
        gap: space.md,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Eyebrow onZone>Malves</Eyebrow>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: live
              ? "#60a5fa"
              : busy || voice.mode
                ? color.zoneText
                : color.zoneMuted,
          }}
        />
        <Text
          style={{ fontFamily: font.mono, fontSize: 12, color: color.zoneMuted, flex: 1 }}
          accessibilityLiveRegion="polite"
        >
          {state}
        </Text>
        {onOpenConversation ? (
          <IconButton
            icon={Conversation}
            label="Conversation"
            onPress={onOpenConversation}
            onZone
          />
        ) : null}
      </View>

      <Text
        style={{ fontFamily: font.sans, fontSize: 17, lineHeight: 25, color: color.zoneText }}
        numberOfLines={4}
      >
        {voice.said ||
          (voice.canListen
            ? "Ask me to start a task, check what's running, or answer what's waiting."
            : "I can read questions aloud here. To talk to me, use the malves app (APK).")}
      </Text>
      {voice.heard ? (
        <Text style={{ fontFamily: font.sans, fontSize: 14, color: color.zoneMuted }}>
          You: {voice.heard}
        </Text>
      ) : null}

      {voice.pending ? (
        <View style={{ gap: space.sm }}>
          <Text style={{ fontFamily: font.medium, fontSize: 15, color: color.zoneText }}>
            {voice.pending.summary}
          </Text>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button
                title="Confirm"
                hint="Malves does what it just read back"
                onPress={() => voice.confirmPending(true)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Cancel"
                kind="secondary"
                onZone
                hint="Nothing happens"
                onPress={() => voice.confirmPending(false)}
              />
            </View>
          </View>
        </View>
      ) : null}

      {voice.problem ? (
        <Text style={{ fontFamily: font.sans, fontSize: 14, color: "#f87171" }}>
          {voice.problem}
        </Text>
      ) : null}

      {voice.canListen ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy && !voice.mode ? "Stop" : "Talk to Malves"}
            accessibilityHint="Say a command, or answer the oldest question"
            disabled={voice.mode}
            onPress={busy && !voice.mode ? voice.hush : voice.talk}
            style={({ pressed }) => ({
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: live ? color.zoneText : color.primary,
              alignItems: "center",
              justifyContent: "center",
              opacity: voice.mode ? 0.4 : pressed ? 0.85 : 1,
            })}
          >
            {busy && !voice.mode ? (
              <Stop size={24} color={live ? color.zone : color.onPrimary} />
            ) : (
              <Mic size={24} color={color.onPrimary} />
            )}
          </Pressable>
          <View style={{ flex: 1 }}>
            <Button
              title={voice.mode ? "Hands-free: on" : "Hands-free"}
              kind="secondary"
              onZone
              hint="Malves reads questions aloud and keeps listening"
              onPress={voice.toggleMode}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
