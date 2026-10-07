import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import type { Model } from "../model";
import { BackBar, Banner, Button, color, space, styles } from "../ui";
import { useNow } from "../useNow";

/** Between pictures: about one a second, ~50 KB each. */
const PAUSE_MS = 700;

/**
 * Watching the computer's screen live while Malves has it (handover). View
 * only: you tell Malves what to do; it asks before anything that changes
 * something. Tap the picture to zoom in, tap again to fit.
 */
export function ScreenScreen({
  model,
  client,
  status,
  onBack,
}: {
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  onBack: () => void;
}) {
  const [frame, setFrame] = useState<{ uri: string; width: number; height: number; at: number }>();
  const [problem, setProblem] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const { width: windowWidth } = useWindowDimensions();
  const now = useNow(1000);
  const active = model.handover.active;

  useEffect(() => {
    if (!client || !active || status !== "online") return;
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          const ack = await client.screenFrame();
          if (stopped) return;
          if (ack.ok && ack.frame) {
            setFrame({
              uri: `data:image/jpeg;base64,${ack.frame.jpeg}`,
              width: ack.frame.width,
              height: ack.frame.height,
              at: Date.now(),
            });
            setProblem(undefined);
          } else setProblem(ack.error ?? "No picture.");
        } catch {
          if (!stopped) setProblem("Couldn't reach the computer.");
        }
        await new Promise((r) => setTimeout(r, PAUSE_MS));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [client, active, status]);

  const fitWidth = windowWidth - space.xl * 2;
  const width = zoomed ? fitWidth * 2.2 : fitWidth;
  const height = frame ? (width * frame.height) / frame.width : (fitWidth * 9) / 16;
  const age = frame ? Math.max(0, Math.round((now - frame.at) / 1000)) : undefined;

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <BackBar onBack={onBack}>
        {active ? (
          <Button
            title="Stop handover"
            kind="danger"
            onPress={() => void client?.stopHandover().catch(() => {})}
          />
        ) : null}
      </BackBar>
      <View style={{ gap: space.xs }}>
        <Text style={styles.eyebrow}>Live screen</Text>
        <Text style={styles.meta}>
          {!active
            ? "Malves doesn't have the computer."
            : status !== "online"
              ? "Offline: waiting for the computer."
              : age === undefined
                ? "Loading…"
                : age <= 2
                  ? "Live"
                  : `Last picture ${age} s ago`}
        </Text>
      </View>
      {!active ? (
        <Banner tone="info">
          You can watch the screen while Malves has your computer. Tap "Hand over my computer" on
          Home first.
        </Banner>
      ) : null}
      {problem && active ? <Banner tone="warn">{problem}</Banner> : null}
      {frame && active ? (
        <ScrollView horizontal={zoomed} scrollEnabled={zoomed}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={
              zoomed ? "Screen, zoomed in. Tap to fit." : "Screen. Tap to zoom in."
            }
            onPress={() => setZoomed((z) => !z)}
          >
            <Image
              source={{ uri: frame.uri }}
              style={{
                width,
                height,
                borderRadius: 12,
                backgroundColor: color.zone,
              }}
              resizeMode="contain"
              fadeDuration={0}
            />
          </Pressable>
        </ScrollView>
      ) : null}
      <Text style={styles.muted}>
        View only. Tell Malves what to do; it reads back anything that changes something.
      </Text>
    </ScrollView>
  );
}
