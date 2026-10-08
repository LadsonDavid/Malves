import type { LinkClient, LinkStatus, ScreenInput } from "@malves/protocol";
import { useEffect, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { Model } from "../model";
import { BackBar, Banner, Button, buzz, Choices, color, space, styles } from "../ui";
import { useNow } from "../useNow";

/** The next picture is asked for as soon as one arrives (about three a second; at most five). */
const MIN_GAP_MS = 200;

type Mode = "watch" | "control";
type Tap = "click" | "double" | "right";

const KEYS: Array<{ label: string; keys: string }> = [
  { label: "Enter", keys: "enter" },
  { label: "⌫", keys: "backspace" },
  { label: "Esc", keys: "esc" },
  { label: "Tab", keys: "tab" },
  { label: "Ctrl+C", keys: "ctrl+c" },
  { label: "Ctrl+V", keys: "ctrl+v" },
  { label: "Ctrl+Z", keys: "ctrl+z" },
  { label: "Ctrl+S", keys: "ctrl+s" },
  { label: "Alt+Tab", keys: "alt+tab" },
  { label: "Win", keys: "win" },
];

/**
 * Your computer's screen, live, any time. In Control, a tap clicks there on
 * the computer, and you can scroll, type and press keys. The computer shows a
 * notification when a phone starts watching or takes control.
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
  const [mode, setMode] = useState<Mode>("watch");
  const [tap, setTap] = useState<Tap>("click");
  const [text, setText] = useState("");
  const { width: windowWidth } = useWindowDimensions();
  const now = useNow(1000);
  const online = status === "online";

  useEffect(() => {
    if (!client || !online) return;
    let stopped = false;
    void (async () => {
      while (!stopped) {
        const started = Date.now();
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
        const wait = MIN_GAP_MS - (Date.now() - started);
        await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [client, online]);

  const send = async (input: Omit<ScreenInput, "type" | "command_id">) => {
    if (!client) return;
    try {
      const ack = await client.screenInput(input);
      if (ack.ok) buzz();
      else setProblem(ack.error ?? "The computer didn't do that.");
    } catch {
      setProblem("Couldn't reach the computer.");
    }
  };

  const fitWidth = windowWidth - space.xl * 2;
  const width = zoomed ? fitWidth * 2.2 : fitWidth;
  const height = frame ? (width * frame.height) / frame.width : (fitWidth * 9) / 16;
  const age = frame ? Math.max(0, Math.round((now - frame.at) / 1000)) : undefined;
  const control = mode === "control";

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <BackBar onBack={onBack}>
        {model.handover.active ? (
          <Button
            title="Stop handover"
            kind="danger"
            onPress={() => void client?.stopHandover().catch(() => {})}
          />
        ) : null}
      </BackBar>
      <View style={{ gap: space.xs }}>
        <Text style={styles.eyebrow}>Your screen</Text>
        <Text style={styles.meta}>
          {!online
            ? "Offline: waiting for the computer."
            : age === undefined
              ? "Loading…"
              : age <= 2
                ? "Live"
                : `Last picture ${age} s ago`}
        </Text>
      </View>
      <Choices<Mode>
        options={[
          { value: "watch", label: "Watch" },
          { value: "control", label: "Control" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {control ? (
        <Choices<Tap>
          options={[
            { value: "click", label: "Tap clicks" },
            { value: "double", label: "Double-click" },
            { value: "right", label: "Right-click" },
          ]}
          value={tap}
          onChange={setTap}
        />
      ) : null}
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {frame ? (
        <ScrollView horizontal={zoomed} scrollEnabled={zoomed}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={
              control
                ? "Screen. Tap to click there on the computer."
                : zoomed
                  ? "Screen, zoomed in. Tap to fit."
                  : "Screen. Tap to zoom in."
            }
            onPress={(e) => {
              if (!control) return setZoomed((z) => !z);
              const x = Math.min(1, Math.max(0, e.nativeEvent.locationX / width));
              const y = Math.min(1, Math.max(0, e.nativeEvent.locationY / height));
              void send({ action: tap, x, y });
              // A double or right click is a one-off; taps go back to plain clicks.
              setTap("click");
            }}
          >
            <Image
              source={{ uri: frame.uri }}
              style={{ width, height, borderRadius: 12, backgroundColor: color.zone }}
              resizeMode="contain"
              fadeDuration={0}
            />
          </Pressable>
        </ScrollView>
      ) : null}
      {control ? (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Button title="Zoom" kind="secondary" onPress={() => setZoomed((z) => !z)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Scroll up"
                kind="secondary"
                onPress={() => void send({ action: "scroll", lines: -5 })}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                title="Scroll down"
                kind="secondary"
                onPress={() => void send({ action: "scroll", lines: 5 })}
              />
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Type on the computer"
              value={text}
              onChangeText={setText}
              onSubmitEditing={() => {
                if (!text) return;
                void send({ action: "type", text });
                setText("");
              }}
            />
            <Button
              title="Send"
              disabled={!text}
              onPress={() => {
                void send({ action: "type", text });
                setText("");
              }}
            />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {KEYS.map((k) => (
              <Button
                key={k.keys}
                title={k.label}
                kind="secondary"
                onPress={() => void send({ action: "keys", keys: k.keys })}
              />
            ))}
          </View>
          <Text style={styles.muted}>
            Taps click on the computer where you tap. Zoom in for small buttons. The computer shows
            a notice that your phone is in control.
          </Text>
        </View>
      ) : (
        <Text style={styles.muted}>
          Tap the picture to zoom. Switch to Control to click and type on the computer.
        </Text>
      )}
    </ScrollView>
  );
}
