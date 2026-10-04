import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { ActivityIndicator, Appearance, Pressable, StyleSheet, Text, View } from "react-native";

/**
 * Colours follow the phone's light or dark setting, read when the app starts
 * (ponytail: a switch while the app is open applies on the next start).
 */
const dark = Appearance.getColorScheme() === "dark";

export const color = dark
  ? {
      text: "#f3f4f6",
      muted: "#9ca3af",
      line: "#374151",
      card: "#1f2937",
      page: "#111827",
      primary: "#3b82f6",
      danger: "#f87171",
      ok: "#4ade80",
      warn: "#fbbf24",
      badBg: "#4c1d1d",
      infoBg: "#1e3a5f",
      okBg: "#14532d",
      warnBg: "#4a3712",
    }
  : {
      text: "#111827",
      muted: "#6b7280",
      line: "#e5e7eb",
      card: "#ffffff",
      page: "#f3f4f6",
      primary: "#2563eb",
      danger: "#b91c1c",
      ok: "#15803d",
      warn: "#b45309",
      badBg: "#fee2e2",
      infoBg: "#dbeafe",
      okBg: "#dcfce7",
      warnBg: "#fef3c7",
    };

export const isDark = dark;

/** A short, light buzz confirming an action reached the computer. */
export function buzz(): void {
  void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(() => {});
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  kind?: "primary" | "plain" | "danger";
  disabled?: boolean;
  busy?: boolean;
  /** For screen readers, when the title alone isn't enough. */
  hint?: string;
};

/** At least 48dp tall: a lock-screen-speed tap shouldn't miss. */
export function Button({ title, onPress, kind = "primary", disabled, busy, hint }: ButtonProps) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={hint}
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

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  /** e.g. "See all" on the right of the title. */
  action?: { label: string; onPress: () => void } | undefined;
}) {
  return (
    <View style={styles.section}>
      <View style={[styles.row, { justifyContent: "space-between", alignItems: "center" }]}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action ? (
          <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={12}>
            <Text style={styles.link}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A card; tappable (with a "›" cue) when `onPress` is given. */
export function Card({
  children,
  onPress,
  label,
}: {
  children: ReactNode;
  onPress?: () => void;
  /** What a screen reader says for a tappable card. */
  label?: string;
}) {
  if (!onPress) return <View style={styles.card}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.dim]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, gap: 6 }}>{children}</View>
        <Text style={[styles.muted, { fontSize: 22 }]}>›</Text>
      </View>
    </Pressable>
  );
}

export type Tone = "bad" | "info" | "ok" | "warn";

const TONE_BG: Record<Tone, string> = {
  bad: color.badBg,
  info: color.infoBg,
  ok: color.okBg,
  warn: color.warnBg,
};
const TONE_FG: Record<Tone, string> = {
  bad: color.danger,
  info: color.primary,
  ok: color.ok,
  warn: color.warn,
};

export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <View style={[styles.banner, { backgroundColor: TONE_BG[tone] }]}>
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

/** A small coloured label, e.g. a task's state. */
export function Chip({ label, tone }: { label: string; tone: Tone | "plain" }) {
  return (
    <View style={[styles.chip, { backgroundColor: tone === "plain" ? color.line : TONE_BG[tone] }]}>
      <Text style={[styles.chipText, { color: tone === "plain" ? color.muted : TONE_FG[tone] }]}>
        {label}
      </Text>
    </View>
  );
}

/** A row of choices where one is selected, e.g. history filters. */
export function Choices<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.row}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[
              styles.choice,
              on && { backgroundColor: color.primary, borderColor: color.primary },
            ]}
          >
            <Text style={[styles.choiceText, on && { color: "#fff" }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const styles = StyleSheet.create({
  page: { flexGrow: 1, backgroundColor: color.page, padding: 16, gap: 16 },
  title: { fontSize: 24, fontWeight: "700", color: color.text },
  body: { fontSize: 16, color: color.text, lineHeight: 22 },
  muted: { fontSize: 14, color: color.muted },
  link: { fontSize: 14, color: color.primary, fontWeight: "600" },
  mono: { fontFamily: "monospace", fontSize: 12, color: color.text },
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
  bannerText: { fontSize: 15, color: color.text },
  chip: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  chipText: { fontSize: 12, fontWeight: "700" },
  choice: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: color.line,
    justifyContent: "center",
  },
  choiceText: { fontSize: 14, fontWeight: "600", color: color.text },
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
