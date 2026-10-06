import { Pressable, Text, View } from "react-native";
import { Home, type Icon, Leads, Settings, Tasks } from "../icons";
import { color, font } from "../ui";

export type Tab = "home" | "tasks" | "leads" | "settings";

const TABS: Array<{ tab: Tab; label: string; icon: Icon }> = [
  { tab: "home", label: "Home", icon: Home },
  { tab: "tasks", label: "Tasks", icon: Tasks },
  { tab: "leads", label: "Leads", icon: Leads },
  { tab: "settings", label: "Settings", icon: Settings },
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
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        borderTopWidth: 1,
        borderTopColor: color.line,
        backgroundColor: color.page,
        paddingBottom: Math.max(bottomInset, 6),
      }}
    >
      {TABS.map(({ tab, label, icon: IconOf }) => {
        const on = tab === current;
        const badge = badges[tab] ?? 0;
        const tint = on ? color.link : color.muted;
        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={badge > 0 ? `${label}, ${badge} waiting` : label}
            onPress={() => onChange(tab)}
            style={{ flex: 1, alignItems: "center", paddingTop: 8, gap: 4, minHeight: 56 }}
          >
            <View>
              <IconOf size={24} color={tint} />
              {badge > 0 ? (
                <View
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -10,
                    backgroundColor: color.danger,
                    borderRadius: 9,
                    minWidth: 18,
                    height: 18,
                    paddingHorizontal: 4,
                    alignItems: "center",
                    justifyContent: "center",
                    borderWidth: 2,
                    borderColor: color.page,
                  }}
                >
                  <Text style={{ color: "#ffffff", fontSize: 10, fontFamily: font.monoMedium }}>
                    {badge > 9 ? "9+" : badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{ fontSize: 12, fontFamily: on ? font.semibold : font.medium, color: tint }}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
