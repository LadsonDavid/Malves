import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Camera, Close } from "../icons";
import { BackBar, Banner, Button, color, IconButton, space, styles, Title } from "../ui";
import { VoiceBar } from "../voice/VoiceBar";
import { useVoice } from "../voice/VoiceProvider";

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Everything said with Malves this session, newest at the bottom, the mic, and "look at this". */
export function MalvesScreen({ onBack }: { onBack: () => void }) {
  const voice = useVoice();
  const scroll = useRef<ScrollView>(null);
  const [looking, setLooking] = useState(false);

  if (looking) return <Look onDone={() => setLooking(false)} />;

  return (
    <View style={{ flex: 1, backgroundColor: color.page }}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={[styles.page, { paddingBottom: space.lg }]}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
      >
        <BackBar onBack={onBack}>
          {voice.assistantOn ? (
            <Button
              title="Look at this"
              kind="ghost"
              icon={Camera}
              hint="Show Malves something with the camera"
              onPress={() => setLooking(true)}
            />
          ) : null}
        </BackBar>
        <Title eyebrow="Conversation">Malves</Title>
        {voice.log.length === 0 ? (
          <Text style={styles.muted}>Nothing said yet. Tap the mic and talk.</Text>
        ) : null}
        {voice.log.map((line, i) =>
          line.who === "you" ? (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at the end
              key={i}
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
            // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at the end
            <View key={i} style={{ maxWidth: "92%", gap: 2 }}>
              <Text style={styles.meta}>MALVES · {clock(line.at)}</Text>
              <Text style={styles.body} selectable>
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

/** The camera: point at a screen, an error, a diagram; Malves says what it sees. */
function Look({ onDone }: { onDone: () => void }) {
  const voice = useVoice();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [size, setSize] = useState<string>();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  // About 1280 px wide is plenty for reading a screen, and keeps the upload small.
  const pickSize = async () => {
    const sizes = (await camera.current?.getAvailablePictureSizesAsync().catch(() => [])) ?? [];
    const parsed = sizes
      .map((s) => ({ s, w: Number(s.split("x")[0]) }))
      .filter((x) => x.w > 0)
      .sort((a, b) => a.w - b.w);
    setSize((parsed.find((x) => x.w >= 1200) ?? parsed.at(-1))?.s);
  };

  const shoot = async () => {
    if (!camera.current) return;
    setBusy(true);
    try {
      const photo = await camera.current.takePictureAsync({
        quality: 0.5,
        base64: true,
        shutterSound: false,
      });
      if (photo?.base64) {
        onDone();
        await voice.look(photo.base64, question.trim());
      }
    } finally {
      setBusy(false);
    }
  };

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <ScrollView contentContainerStyle={styles.page}>
        <BackBar onBack={onDone} />
        <Title>Look at this</Title>
        <Text style={styles.body}>Malves needs the camera to see what you show it.</Text>
        <Button title="Allow the camera" onPress={() => void requestPermission()} />
      </ScrollView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.zone }}>
      <CameraView
        ref={camera}
        style={{ flex: 1 }}
        facing="back"
        {...(size ? { pictureSize: size } : {})}
        onCameraReady={() => void pickSize()}
      />
      <View style={{ padding: space.lg, gap: space.md }}>
        <TextInput
          style={[
            styles.input,
            { backgroundColor: color.zone, color: color.zoneText, borderColor: color.zoneLine },
          ]}
          placeholder="Ask about it (optional)"
          placeholderTextColor={color.zoneMuted}
          value={question}
          onChangeText={setQuestion}
        />
        {!voice.assistantOn ? <Banner tone="warn">Malves isn't reachable right now.</Banner> : null}
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <IconButton icon={Close} label="Cancel" onPress={onDone} onZone />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Take the photo"
            disabled={busy || !voice.assistantOn}
            onPress={() => void shoot()}
            style={({ pressed }) => ({
              width: 72,
              height: 72,
              borderRadius: 36,
              borderWidth: 4,
              borderColor: color.zoneText,
              backgroundColor: pressed || busy ? color.zoneMuted : color.primary,
              opacity: voice.assistantOn ? 1 : 0.4,
            })}
          />
          <View style={{ width: 48 }} />
        </View>
      </View>
    </View>
  );
}
