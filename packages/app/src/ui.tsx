import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

export const color = {
  text: "#111827",
  muted: "#6b7280",
  line: "#e5e7eb",
  card: "#ffffff",
  page: "#f3f4f6",
  primary: "#2563eb",
  danger: "#b91c1c",
  ok: "#15803d",
  warn: "#b45309",
};

type ButtonProps = {
  title: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger";
  disabled?: boolean;
  busy?: boolean;
};

/** At least 48dp tall: a lock-screen-speed tap shouldn't miss. */
export function Button({ title, onPress, kind = "primary", disabled, busy }: ButtonProps) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === "primary" && styles.primary,
        kind === "danger" && styles.danger,
        kind === "plain" && styles.plain,
        (pressed || off) && styles.dim,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={kind === "plain" ? color.primary : "#fff"} />
      ) : (
        <Text style={[styles.buttonText, kind === "plain" && styles.plainText]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Banner({ tone, children }: { tone: "bad" | "info"; children: ReactNode }) {
  return (
    <View style={[styles.banner, tone === "bad" ? styles.bad : styles.info]}>
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  page: { flexGrow: 1, backgroundColor: color.page, padding: 16, paddingTop: 48, gap: 16 },
  title: { fontSize: 24, fontWeight: "700", color: color.text },
  body: { fontSize: 16, color: color.text, lineHeight: 22 },
  muted: { fontSize: 14, color: color.muted },
  section: { gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: color.muted, textTransform: "uppercase" },
  card: {
    backgroundColor: color.card,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: color.line,
  },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: {
    minHeight: 48,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: color.primary },
  danger: { backgroundColor: color.danger },
  plain: { backgroundColor: "transparent", borderWidth: 1, borderColor: color.line },
  dim: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  plainText: { color: color.primary },
  banner: { borderRadius: 10, padding: 12 },
  bad: { backgroundColor: "#fee2e2" },
  info: { backgroundColor: "#dbeafe" },
  bannerText: { fontSize: 15, color: color.text },
  input: {
    backgroundColor: color.card,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
    color: color.text,
    minHeight: 48,
  },
});
