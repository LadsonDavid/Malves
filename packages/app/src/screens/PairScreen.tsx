import { PairingOffer } from "@malves/protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { Banner, Button, styles } from "../ui";

type Props = {
  /** Why the last pairing attempt failed, if it did. */
  error: string | undefined;
  onOffer: (offer: PairingOffer) => void;
};

/** Scan the QR code `malves serve` shows, or paste its text (for emulators). */
export function PairScreen({ error, onOffer }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [pasted, setPasted] = useState("");
  const [problem, setProblem] = useState<string>();
  const used = useRef(false);

  const read = (text: string): boolean => {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const offer = PairingOffer.safeParse(json);
    if (!offer.success) {
      setProblem("That isn't a malves pairing code.");
      return false;
    }
    setProblem(undefined);
    onOffer(offer.data);
    return true;
  };

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Pair with your computer</Text>
      <Text style={styles.body}>
        On your computer, run <Text style={{ fontWeight: "700" }}>malves serve</Text> and scan the
        code it shows. Codes last two minutes.
      </Text>
      {error ? <Banner tone="bad">{error}</Banner> : null}

      {permission?.granted ? (
        <CameraView
          style={{ height: 320, borderRadius: 12 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => {
            // The scanner fires many times a second; act on the first good code only.
            if (!used.current && read(data)) used.current = true;
          }}
        />
      ) : (
        <Button title="Use the camera to scan" onPress={() => void requestPermission()} />
      )}

      <Text style={styles.muted}>
        Can't scan? Type "pair text" in malves serve, then paste the line it prints:
      </Text>
      <TextInput
        style={[styles.input, { minHeight: 96 }]}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        placeholder='{"v":1,"url":"ws://…"}'
        value={pasted}
        onChangeText={setPasted}
      />
      <Button title="Connect" disabled={pasted.trim() === ""} onPress={() => read(pasted.trim())} />
      {problem ? <Banner tone="bad">{problem}</Banner> : null}
    </ScrollView>
  );
}
