import type { LinkClient, LinkStatus, ScreenInput } from "@malves/protocol";
import * as ScreenOrientation from "expo-screen-orientation";
import { useEffect, useRef, useState } from "react";
import {
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { Model } from "../model";
import { BackBar, Banner, Button, buzz, Choices, color, space, styles } from "../ui";

/** WebRTC (native: the APK only). In Expo Go the old pictures are used. */
type WebRtc = typeof import("react-native-webrtc");
let webrtc: WebRtc | undefined;
try {
  webrtc = require("react-native-webrtc") as WebRtc;
} catch {
  webrtc = undefined;
}

type Input = Omit<ScreenInput, "type" | "command_id">;
type Mode = "tap" | "trackpad";

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
 * Your computer's screen, live (real video over WebRTC, about 13 frames a
 * second in full HD), and control: tap the picture to click there, or use
 * Trackpad (drag moves the pointer, tap clicks). Landscape for a full view.
 * The computer shows a notification when a phone watches or takes control.
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
  const [streamUrl, setStreamUrl] = useState<string>();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [frame, setFrame] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [locked, setLocked] = useState(false);
  const [mode, setMode] = useState<Mode>("tap");
  const [zoomed, setZoomed] = useState(false);
  const [full, setFull] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const online = status === "online";

  const send = async (input: Input) => {
    if (!client) return;
    try {
      const ack = await client.screenInput(input);
      if (ack.ok) buzz();
      else setProblem(ack.error ?? "The computer didn't do that.");
    } catch {
      setProblem("Couldn't reach the computer.");
    }
  };

  // Live video; if it can't start, pictures as before.
  useEffect(() => {
    if (!client || !online) return;
    let stopped = false;
    let peer: InstanceType<WebRtc["RTCPeerConnection"]> | undefined;
    const pictures = async () => {
      while (!stopped) {
        try {
          const ack = await client.screenFrame();
          if (stopped) return;
          if (ack.ok && ack.frame) {
            setFrame(`data:image/jpeg;base64,${ack.frame.jpeg}`);
            setSize({ width: ack.frame.width, height: ack.frame.height });
          }
        } catch {
          // Next round.
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    void (async () => {
      if (!webrtc) return pictures();
      try {
        peer = new webrtc.RTCPeerConnection({ iceServers: [] });
        peer.addTransceiver("video", { direction: "recvonly" });
        peer.ontrack = (event: unknown) => {
          const { streams } = event as unknown as { streams?: Array<{ toURL: () => string }> };
          const stream = streams?.[0];
          if (stream && !stopped) setStreamUrl(stream.toURL());
        };
        await peer.setLocalDescription(await peer.createOffer({}));
        await new Promise<void>((resolve) => {
          if (peer?.iceGatheringState === "complete") return resolve();
          const done = setTimeout(resolve, 3000);
          if (peer)
            peer.onicegatheringstatechange = () => {
              if (peer?.iceGatheringState === "complete") {
                clearTimeout(done);
                resolve();
              }
            };
        });
        const ack = await client.screenVideo(peer.localDescription?.sdp ?? "");
        if (!ack.ok || !ack.video) throw new Error(ack.error ?? "No video");
        setSize({ width: ack.video.width, height: ack.video.height });
        await peer.setRemoteDescription(
          new webrtc.RTCSessionDescription({ type: "answer", sdp: ack.video.sdp }),
        );
      } catch {
        peer?.close();
        peer = undefined;
        if (!stopped) void pictures();
      }
    })();
    return () => {
      stopped = true;
      if (peer) {
        peer.close();
        void client.screenVideoStop().catch(() => {});
      }
    };
  }, [client, online]);

  // Full screen turns the phone sideways; leaving puts it back.
  useEffect(() => {
    void ScreenOrientation.lockAsync(
      full
        ? ScreenOrientation.OrientationLock.LANDSCAPE
        : ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ).catch(() => {});
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
        () => {},
      );
    };
  }, [full]);

  const aspect = size ? size.height / size.width : 9 / 16;
  const fit = full ? Math.min(windowWidth, windowHeight / aspect) : windowWidth - space.xl * 2;
  const width = zoomed ? fit * 2 : fit;
  const height = width * aspect;

  // Trackpad: drag moves the pointer (relative, like a laptop's), tap clicks.
  const start = useRef({ x: 0.5, y: 0.5 });
  const pad = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        start.current = cursorRef.current;
      },
      onPanResponderMove: (_e, g) => {
        const next = {
          x: Math.min(1, Math.max(0, start.current.x + g.dx / 400)),
          y: Math.min(1, Math.max(0, start.current.y + g.dy / 400)),
        };
        setCursor(next);
      },
      onPanResponderRelease: (_e, g) => {
        const moved = Math.abs(g.dx) + Math.abs(g.dy) > 6;
        const at = cursorRef.current;
        void send({ action: moved ? "move" : "click", x: at.x, y: at.y });
      },
    }),
  ).current;

  const picture = (
    <View style={{ width, height, borderRadius: full ? 0 : 12, overflow: "hidden" }}>
      {streamUrl && webrtc ? (
        <webrtc.RTCView streamURL={streamUrl} objectFit="contain" style={{ width, height }} />
      ) : frame ? (
        <Image
          source={{ uri: frame }}
          style={{ width, height }}
          resizeMode="contain"
          fadeDuration={0}
        />
      ) : (
        <View style={{ width, height, backgroundColor: color.zone }} />
      )}
      {mode === "trackpad" && !locked ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: cursor.x * width - 9,
            top: cursor.y * height - 9,
            width: 18,
            height: 18,
            borderRadius: 9,
            borderWidth: 2,
            borderColor: "#60a5fa",
          }}
        />
      ) : null}
      {!locked ? (
        mode === "trackpad" ? (
          <View {...pad.panHandlers} style={{ position: "absolute", inset: 0 }} />
        ) : (
          <Pressable
            accessibilityLabel="Screen. Tap to click there on the computer; hold for a right-click."
            style={{ position: "absolute", inset: 0 }}
            onPress={(e) =>
              void send({
                action: "click",
                x: Math.min(1, Math.max(0, e.nativeEvent.locationX / width)),
                y: Math.min(1, Math.max(0, e.nativeEvent.locationY / height)),
              })
            }
            onLongPress={(e) =>
              void send({
                action: "right",
                x: Math.min(1, Math.max(0, e.nativeEvent.locationX / width)),
                y: Math.min(1, Math.max(0, e.nativeEvent.locationY / height)),
              })
            }
          />
        )
      ) : null}
    </View>
  );

  const bar = (
    <View style={[styles.row, { alignItems: "center" }]}>
      <Button
        title={locked ? "Locked" : "Touch on"}
        kind="secondary"
        onPress={() => setLocked((l) => !l)}
        hint="Lock to watch without clicking by accident"
      />
      <Button
        title={full ? "Exit full screen" : "Full screen"}
        kind="secondary"
        onPress={() => setFull((f) => !f)}
      />
      <Button
        title={zoomed ? "Fit" : "Zoom"}
        kind="secondary"
        onPress={() => setZoomed((z) => !z)}
      />
      <Button title="Keyboard" kind="secondary" onPress={() => setKeyboard((k) => !k)} />
    </View>
  );

  if (full) {
    return (
      <View
        style={{ flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" }}
      >
        <ScrollView
          horizontal={zoomed}
          scrollEnabled={zoomed}
          contentContainerStyle={{ alignItems: "center" }}
        >
          {picture}
        </ScrollView>
        <View style={{ position: "absolute", top: space.sm, right: space.sm }}>
          <Button title="Exit full screen" kind="secondary" onZone onPress={() => setFull(false)} />
        </View>
      </View>
    );
  }

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
            : streamUrl
              ? "Live video"
              : frame
                ? "Live"
                : "Connecting…"}
        </Text>
      </View>
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      <ScrollView horizontal={zoomed} scrollEnabled={zoomed}>
        {picture}
      </ScrollView>
      <Choices<Mode>
        options={[
          { value: "tap", label: "Tap to click" },
          { value: "trackpad", label: "Trackpad" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {bar}
      <View style={[styles.row]}>
        <Button
          title="Scroll up"
          kind="secondary"
          onPress={() => void send({ action: "scroll", lines: -5 })}
        />
        <Button
          title="Scroll down"
          kind="secondary"
          onPress={() => void send({ action: "scroll", lines: 5 })}
        />
      </View>
      {keyboard ? (
        <View style={{ gap: space.sm }}>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Type on the computer"
              value={text}
              onChangeText={setText}
              autoFocus
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
          <View style={styles.row}>
            {KEYS.map((k) => (
              <Button
                key={k.keys}
                title={k.label}
                kind="secondary"
                onPress={() => void send({ action: "keys", keys: k.keys })}
              />
            ))}
          </View>
        </View>
      ) : null}
      <Text style={styles.muted}>
        {mode === "tap"
          ? "Tap to click, hold for a right-click."
          : "Drag to move the pointer, tap to click."}
      </Text>
    </ScrollView>
  );
}
