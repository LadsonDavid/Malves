import type { Ack, LinkClient, LinkStatus } from "@malves/protocol";
import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { ago } from "../model";
import { Banner, Choices, List, Row, styles } from "../ui";

export type SessionRow = NonNullable<Ack["all_sessions"]>[number];
type ToolFilter = "all" | SessionRow["tool"];

export const TOOL_LABEL: Record<SessionRow["tool"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

const FILTERS: Array<{ value: ToolFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "antigravity", label: "Antigravity" },
];

/** Every session on the computer, newest first: search, filter by tool, tap to open. */
export function SessionsList({
  client,
  status,
  onOpen,
  refreshKey,
}: {
  client: LinkClient | undefined;
  status: LinkStatus;
  onOpen: (session: SessionRow) => void;
  /** Changes when the user pulls to refresh. */
  refreshKey: number;
}) {
  const [all, setAll] = useState<SessionRow[]>();
  const [problem, setProblem] = useState<string>();
  const [tool, setTool] = useState<ToolFilter>("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (!client || status !== "online") return;
    try {
      const ack = await client.allSessions();
      if (ack.ok) {
        setAll(ack.all_sessions ?? []);
        setProblem(undefined);
      } else setProblem(ack.error ?? "The computer couldn't list sessions.");
    } catch {
      setProblem("Couldn't reach the computer.");
    }
  }, [client, status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads when pulled to refresh
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const words = search.trim().toLowerCase();
  const shown = (all ?? []).filter(
    (s) =>
      (tool === "all" || s.tool === tool) &&
      (!words || `${s.title} ${s.folder ?? ""}`.toLowerCase().includes(words)),
  );

  return (
    <View style={{ gap: 12 }}>
      <TextInput
        style={styles.input}
        placeholder="Search sessions or folders"
        value={search}
        onChangeText={setSearch}
        autoCorrect={false}
      />
      <Choices options={FILTERS} value={tool} onChange={setTool} />
      {problem ? <Banner tone="warn">{problem}</Banner> : null}
      {status !== "online" && !all ? (
        <Text style={styles.muted}>Sessions show when the computer is online.</Text>
      ) : null}
      {all && shown.length === 0 ? <Text style={styles.muted}>No sessions match.</Text> : null}
      {shown.length > 0 ? (
        <List>
          {shown.slice(0, 80).map((s) => (
            <Row
              key={`${s.tool}:${s.id}`}
              onPress={() => onOpen(s)}
              label={`${TOOL_LABEL[s.tool]}: ${s.title}`}
            >
              <Text style={styles.meta}>
                {TOOL_LABEL[s.tool].toUpperCase()}
                {s.source === "editor" ? " · EDITOR" : ""} ·{" "}
                {ago(new Date(s.updated_at).toISOString())}
              </Text>
              <Text style={styles.body} numberOfLines={2}>
                {s.title}
              </Text>
              {s.folder ? (
                <Text style={styles.muted} numberOfLines={1}>
                  {s.folder.split(/[\\/]/).filter(Boolean).at(-1)}
                </Text>
              ) : null}
            </Row>
          ))}
        </List>
      ) : null}
      {shown.length > 80 ? (
        <Text style={styles.muted}>Showing the newest 80. Search to find older ones.</Text>
      ) : null}
    </View>
  );
}
