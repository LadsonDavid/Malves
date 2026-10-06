import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import { ActivityIndicator, Appearance, Pressable, Text, View } from "react-native";
import { Back, Check as CheckIcon, ChevronRight, type Icon, Info, Warning } from "./icons";

/**
 * The Malveon blueprint system (DESIGN.md), on a phone: paper and navy zones,
 * one cobalt anchor at or under 10% of the screen, hairlines instead of boxes,
 * Fraunces for screen titles, Geist for everything else, Geist Mono for
 * labels, ids and times.
 *
 * `color` and `styles` are updated in place when the phone switches between
 * light and dark; App re-renders the screens when that happens.
 */
const LIGHT = {
  page: "#fbfaf8", // ln-paper
  card: "#fbfaf8",
  sunken: "#f4f2ee", // ln-paper-2
  text: "#0d1117", // ln-ink
  muted: "#5c6068", // ln-ink-60
  line: "#e7e4df", // ln-line-light
  primary: "#012bff", // ln-cobalt: fills, focus
  link: "#012bff",
  onPrimary: "#ffffff", // ln-on-navy
  tint: "#eef3ff", // ln-brand-tint
  ok: "#16a34a", // ln-pass-text
  danger: "#ef4444", // ln-danger
  warn: "#f97316", // ln-caution
  /** The navy zone Malves lives in, in both themes. */
  zone: "#0a0a0a", // ln-navy
  zoneText: "#ffffff",
  zoneMuted: "#94a3b8", // ln-mute
  zoneLine: "rgba(255,255,255,0.10)", // ln-line-dark
  scrim: "rgba(10,10,10,0.4)",
};
type Palette = typeof LIGHT;

const DARK: Palette = {
  page: "#0a0a0a", // ln-navy
  card: "#1a1a1a", // ln-navy-soft
  sunken: "#141414",
  text: "#ffffff", // ln-on-navy
  muted: "#94a3b8", // ln-mute
  line: "rgba(255,255,255,0.10)", // ln-line-dark
  primary: "#012bff",
  link: "#60a5fa", // ln-azure: cobalt text is too dark to read on navy
  onPrimary: "#ffffff",
  tint: "rgba(1,43,255,0.18)",
  ok: "#4ade80", // ln-pass-dim
  danger: "#f87171", // ln-danger-soft
  warn: "#fbbf24", // ln-warn-soft
  zone: "#1a1a1a",
  zoneText: "#ffffff",
  zoneMuted: "#94a3b8",
  zoneLine: "rgba(255,255,255,0.10)",
  scrim: "rgba(0,0,0,0.6)",
};

export const color: Palette = { ...LIGHT };
export let isDark = false;

/** Font families, one per weight: Android doesn't pick weights of a custom font by itself. */
export const font = {
  sans: "Geist",
  medium: "Geist-Medium",
  semibold: "Geist-SemiBold",
  mono: "GeistMono",
  monoMedium: "GeistMono-Medium",
  display: "Fraunces",
  displayLight: "Fraunces-Light",
};

/** Spacing on the 4 px base. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
const radius = { cell: 12, card: 18, pill: 9999 };

/** A short, light buzz confirming an action reached the computer. */
export function buzz(): void {
  void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(() => {});
}

// ── Building blocks ─────────────────────────────────────────────────────────

type ButtonProps = {
  title: string;
  onPress: () => void;
  /** primary: the one main action on a screen. secondary (or "plain"): outlined. ghost: text only. danger: outlined, red. */
  kind?: "primary" | "secondary" | "plain" | "ghost" | "danger";
  icon?: Icon | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  /** For screen readers, when the title alone isn't enough. */
  hint?: string | undefined;
  /** On a navy zone. */
  onZone?: boolean | undefined;
};

/** At least 48 dp tall: a lock-screen-speed tap shouldn't miss. */
export function Button({
  title,
  onPress,
  kind = "primary",
  icon: IconOf,
  disabled,
  busy,
  hint,
  onZone,
}: ButtonProps) {
  const off = disabled || busy;
  const variant = kind === "plain" ? "secondary" : kind;
  const fg =
    variant === "primary"
      ? color.onPrimary
      : variant === "danger"
        ? color.danger
        : onZone
          ? color.zoneText
          : color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && { backgroundColor: color.primary },
        (variant === "secondary" || variant === "danger") && {
          borderWidth: 1,
          borderColor: onZone ? color.zoneLine : color.line,
        },
        pressed &&
          variant !== "primary" && {
            backgroundColor: onZone ? color.zoneLine : color.sunken,
          },
        pressed && variant === "primary" && { opacity: 0.85 },
        off && { opacity: 0.45 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {IconOf ? <IconOf size={18} color={fg} /> : null}
          <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

/** A square icon-only button, 48 dp, with a spoken label. */
export function IconButton({
  icon: IconOf,
  label,
  onPress,
  onZone,
}: {
  icon: Icon;
  label: string;
  onPress: () => void;
  onZone?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.iconButton,
        pressed && { backgroundColor: onZone ? color.zoneLine : color.sunken },
      ]}
    >
      <IconOf size={22} color={onZone ? color.zoneText : color.text} />
    </Pressable>
  );
}

/** Mono uppercase label: section names, field labels. */
export function Eyebrow({ children, onZone }: { children: ReactNode; onZone?: boolean }) {
  return <Text style={[styles.eyebrow, onZone && { color: color.zoneMuted }]}>{children}</Text>;
}

/** A screen's title, in Fraunces, with an optional eyebrow above it. */
export function Title({ children, eyebrow }: { children: ReactNode; eyebrow?: string }) {
  return (
    <View style={{ gap: space.xs }}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <Text style={styles.title} accessibilityRole="header">
        {children}
      </Text>
    </View>
  );
}

/** The top of a pushed screen: back on the left, optional actions on the right. */
export function BackBar({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <View style={[styles.rowCenter, { marginLeft: -space.md, justifyContent: "space-between" }]}>
      <IconButton icon={Back} label="Back" onPress={onBack} />
      <View style={styles.rowCenter}>{children}</View>
    </View>
  );
}

export function Hairline({ onZone }: { onZone?: boolean }) {
  return <View style={[styles.hairline, onZone && { backgroundColor: color.zoneLine }]} />;
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
      <View style={styles.sectionHead}>
        <Eyebrow>{title}</Eyebrow>
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

/** A panel. Only for things that stand alone (a question, a form); lists use `List`. */
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
      style={({ pressed }) => [styles.card, pressed && { backgroundColor: color.sunken }]}
    >
      <View style={styles.rowCenter}>
        <View style={{ flex: 1, gap: space.sm }}>{children}</View>
        <ChevronRight size={18} color={color.muted} />
      </View>
    </Pressable>
  );
}

/** Rows separated by hairlines inside one panel: tasks, IDEs, memories. */
export function List({ children }: { children: ReactNode[] }) {
  const rows = children.filter(Boolean);
  return (
    <View style={styles.list}>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order; each row keys its own content
        <View key={i}>
          {i > 0 ? <Hairline /> : null}
          {row}
        </View>
      ))}
    </View>
  );
}

/** One row of a `List`; tappable with a chevron when `onPress` is given. */
export function Row({
  children,
  onPress,
  label,
}: {
  children: ReactNode;
  onPress?: () => void;
  label?: string;
}) {
  if (!onPress) return <View style={styles.listRow}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.listRow, pressed && { backgroundColor: color.sunken }]}
    >
      <View style={styles.rowCenter}>
        <View style={{ flex: 1, gap: space.xs }}>{children}</View>
        <ChevronRight size={18} color={color.muted} />
      </View>
    </Pressable>
  );
}

export type Tone = "bad" | "info" | "ok" | "warn";

const toneColor = (tone: Tone | "plain") =>
  tone === "bad"
    ? color.danger
    : tone === "ok"
      ? color.ok
      : tone === "warn"
        ? color.warn
        : tone === "info"
          ? color.primary
          : color.muted;

/** A note in the flow: tinted, with an icon. No side stripes. */
export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  const IconOf = tone === "ok" ? CheckIcon : tone === "info" ? Info : Warning;
  const c = tone === "info" ? color.link : toneColor(tone);
  return (
    <View
      style={[styles.banner, { backgroundColor: tone === "info" ? color.tint : `${c}1f` }]}
      accessibilityRole={tone === "bad" ? "alert" : undefined}
    >
      <IconOf size={18} color={c} />
      <Text style={[styles.bannerText, { flex: 1 }]}>{children}</Text>
    </View>
  );
}

/** A status pill: tinted, a dot in the status colour, the word in ink (readable at 12 px). */
export function Chip({ label, tone }: { label: string; tone: Tone | "plain" }) {
  const c = toneColor(tone);
  return (
    <View style={[styles.chip, { backgroundColor: tone === "plain" ? color.sunken : `${c}1f` }]}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={styles.chipText}>{label}</Text>
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
              on && { backgroundColor: color.tint, borderColor: color.primary },
            ]}
          >
            {on ? <CheckIcon size={14} color={color.link} /> : null}
            <Text style={[styles.choiceText, on && { color: color.link }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

function makeStyles() {
  return {
    page: { flexGrow: 1, backgroundColor: color.page, padding: space.xl, gap: space.xl },
    title: {
      fontFamily: font.displayLight,
      fontSize: 32,
      lineHeight: 36,
      letterSpacing: -0.3,
      color: color.text,
    },
    h3: { fontFamily: font.semibold, fontSize: 19, lineHeight: 24, color: color.text },
    body: { fontFamily: font.sans, fontSize: 16, lineHeight: 24, color: color.text },
    strong: { fontFamily: font.semibold },
    muted: { fontFamily: font.sans, fontSize: 14, lineHeight: 20, color: color.muted },
    link: { fontFamily: font.medium, fontSize: 14, color: color.link },
    mono: {
      fontFamily: font.mono,
      fontSize: 12,
      lineHeight: 18,
      color: color.text,
      fontVariant: ["tabular-nums" as const],
    },
    meta: {
      fontFamily: font.mono,
      fontSize: 12,
      color: color.muted,
      fontVariant: ["tabular-nums" as const],
    },
    eyebrow: {
      fontFamily: font.monoMedium,
      fontSize: 12,
      letterSpacing: 2.4,
      textTransform: "uppercase" as const,
      color: color.muted,
    },
    section: { gap: space.md },
    sectionHead: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
    },
    hairline: { height: 1, backgroundColor: color.line },
    card: {
      backgroundColor: color.card,
      borderRadius: radius.card,
      padding: space.lg,
      gap: space.md,
      borderWidth: 1,
      borderColor: color.line,
      elevation: isDark ? 0 : 1,
      shadowColor: "#000",
      shadowOpacity: 0.06,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    list: {
      backgroundColor: color.card,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: color.line,
      overflow: "hidden" as const,
    },
    listRow: { paddingHorizontal: space.lg, paddingVertical: space.md + 2, minHeight: 56 },
    rowCenter: { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md },
    /** Things side by side that may wrap: buttons, chips. */
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: space.sm },
    button: {
      minHeight: 48,
      paddingHorizontal: space.lg,
      borderRadius: radius.cell,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: space.sm,
    },
    buttonText: { fontFamily: font.medium, fontSize: 16 },
    iconButton: {
      width: 48,
      height: 48,
      borderRadius: radius.cell,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    banner: {
      borderRadius: radius.cell,
      padding: space.md,
      flexDirection: "row" as const,
      gap: space.sm,
      alignItems: "flex-start" as const,
    },
    bannerText: { fontFamily: font.sans, fontSize: 15, lineHeight: 22, color: color.text },
    chip: {
      borderRadius: radius.pill,
      paddingHorizontal: space.sm,
      paddingVertical: 3,
      alignSelf: "flex-start" as const,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    dot: { width: 6, height: 6, borderRadius: 3 },
    chipText: {
      fontFamily: font.monoMedium,
      fontSize: 11,
      letterSpacing: 0.6,
      textTransform: "uppercase" as const,
      color: color.text,
    },
    choice: {
      minHeight: 40,
      paddingHorizontal: space.md + 2,
      borderRadius: radius.cell,
      borderWidth: 1,
      borderColor: color.line,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    choiceText: { fontFamily: font.medium, fontSize: 14, color: color.text },
    input: {
      backgroundColor: color.card,
      borderWidth: 1,
      borderColor: color.line,
      borderRadius: radius.cell,
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      fontFamily: font.sans,
      fontSize: 16,
      color: color.text,
      minHeight: 48,
    },
  };
}

export const styles = makeStyles();

/** Switches every colour and style to the phone's current theme. */
export function applyScheme(scheme: string | null | undefined): void {
  isDark = scheme === "dark";
  Object.assign(color, isDark ? DARK : LIGHT);
  Object.assign(styles, makeStyles());
}
applyScheme(Appearance.getColorScheme());
