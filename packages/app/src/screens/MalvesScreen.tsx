import { useRef } from "react";
import { ScrollView, Text, View } from "react-native";
import { BackBar, color, font, space, styles, Title } from "../ui";
import { VoiceBar } from "../voice/VoiceBar";
import { useVoice } from "../voice/VoiceProvider";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Everything said with Malves this session, newest at the bottom, and the mic. */
export function MalvesScreen({ onBack }: { onBack: () => void }) {
  const voice = useVoice();
  const scroll = useRef<ScrollView>(null);

  return (
    <View style={{ flex: 1, backgroundColor: color.page }}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={[styles.page, { paddingBottom: space.lg }]}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <BackBar onBack={onBack} />
        <Title eyebrow="Conversation">Malves</Title>
        {voice.log.length === 0 ? (
          <Text style={styles.muted}>Nothing said yet. Tap the mic and talk.</Text>
        ) : null}
        {voice.log.map((line) =>
          line.who === "you" ? (
            <View
              key={`${line.at}-you`}
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
            <View key={`${line.at}-malves`} style={{ maxWidth: "92%", gap: 2 }}>
              <Text style={styles.meta}>MALVES · {clock(line.at)}</Text>
              <Text style={[styles.body, { fontFamily: font.sans }]} selectable>
                {line.text}
              </Text>
            </View>
          ),
        )}
      </ScrollView>
      <View style={{ padding: space.lg, paddingTop: 0 }}>
        <VoiceBar />
      </View>
    </View>
  );
}
