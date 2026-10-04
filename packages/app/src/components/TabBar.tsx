import { Pressable, StyleSheet, Text, View } from "react-native";
import { color } from "../ui";

export type Tab = "home" | "tasks" | "leads" | "settings";

const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: "home", label: "Home" },
  { tab: "tasks", label: "Tasks" },
  { tab: "leads", label: "Leads" },
  { tab: "settings", label: "Settings" },
];

/** The four places in the app, always one tap away. A badge counts what's waiting. */
export function TabBar({
  current,
  onChange,
  badges,
  bottomInset,
}: {
  current: Tab;
  onChange: (tab: Tab) => void;
  badges: Partial<Record<Tab, number>>;
  bottomInset: number;
}) {
  return (
    <View style={[s.bar, { paddingBottom: Math.max(bottomInset, 6) }]} accessibilityRole="tablist">
      {TABS.map(({ tab, label }) => {
        const on = tab === current;
        const badge = badges[tab] ?? 0;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge > 0 ? `${label}, ${badge} waiting` : label}
            onPress={() => onChange(tab)}
            style={s.tab}
          >
            <View style={[s.indicator, on && { backgroundColor: color.primary }]} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={[s.label, on && { color: color.primary }]}>{label}</Text>
              {badge > 0 ? (
                <View style={s.badge}>
                  <Text style={s.badgeText}>{badge > 9 ? "9+" : badge}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: color.line,
    backgroundColor: color.card,
  },
  tab: { flex: 1, alignItems: "center", gap: 6, paddingBottom: 8, minHeight: 52 },
  indicator: { height: 3, width: 32, borderRadius: 2, backgroundColor: "transparent" },
  label: { fontSize: 14, fontWeight: "600", color: color.muted },
  badge: {
    backgroundColor: color.danger,
    borderRadius: 999,
    minWidth: 18,
    paddingHorizontal: 5,
    alignItems: "center",
  },
  badgeText: { color: "#fff", fontSize: 11, fontWeight: "700" },
});
