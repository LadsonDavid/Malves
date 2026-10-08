import { Pressable, Text, View } from "react-native";
import { Mic, Stop } from "../icons";
import { color, font, space } from "../ui";
import { useVoice } from "./VoiceProvider";

/**
 * Malves on every screen: tap to talk (it knows which screen you're on, so
 * "stop this one" works), tap again to stop, hold to open the conversation.
 * While it listens or talks, a small bubble shows what was heard or said.
 */
export function FloatingMic({ bottom, onOpen }: { bottom: number; onOpen: () => void }) {
  const voice = useVoice();
  if (!voice.canListen) return null;
  const busy = voice.phase !== "idle";
  const line = voice.phase === "listening" ? voice.heard || "Listening…" : voice.said;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        right: space.lg,
        left: space.lg,
        bottom,
        alignItems: "flex-end",
        gap: space.sm,
      }}
    >
      {busy && line ? (
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel="Open the conversation with Malves"
          style={{
            backgroundColor: color.zone,
            borderRadius: 14,
            padding: space.md,
            maxWidth: "88%",
          }}
        >
          <Text
            numberOfLines={3}
            style={{ color: color.zoneText, fontFamily: font.sans, fontSize: 15 }}
          >
            {line}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={busy ? "Stop Malves" : "Talk to Malves"}
        accessibilityHint="Hold to open the conversation"
        onPress={busy ? voice.hush : voice.talk}
        onLongPress={onOpen}
        style={({ pressed }) => ({
          width: 60,
          height: 60,
          borderRadius: 30,
          backgroundColor: voice.phase === "listening" ? color.zoneText : color.primary,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.85 : 1,
          elevation: 6,
          shadowColor: "#000",
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
        })}
      >
        {busy ? (
          <Stop size={26} color={voice.phase === "listening" ? color.zone : color.onPrimary} />
        ) : (
          <Mic size={26} color={color.onPrimary} />
        )}
      </Pressable>
    </View>
  );
}
