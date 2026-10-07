import type { LinkClient, LinkStatus } from "@malves/protocol";
import { useState } from "react";
import { RefreshControl, ScrollView, Text } from "react-native";
import { TaskRow } from "../components/TaskRow";
import { history, type Model, type TaskFilter } from "../model";
import { Choices, List, styles, Title } from "../ui";
import { type SessionRow, SessionsList } from "./SessionsList";

const FILTERS: Array<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Running" },
  { value: "done", label: "Done" },
  { value: "unfinished", label: "Failed or stopped" },
];

const EMPTY: Record<TaskFilter, string> = {
  all: "No tasks yet. Start one from Home.",
  active: "Nothing is running.",
  done: "No finished tasks yet.",
  unfinished: "Nothing failed or was stopped.",
};

type View = "sessions" | "tasks";

/**
 * Your work: every session on the computer (Claude Code, Codex, Cursor,
 * Antigravity), and the tasks malves ran.
 */
export function TasksScreen({
  model,
  client,
  status,
  onOpenTask,
  onOpenSession,
}: {
  model: Model;
  client: LinkClient | undefined;
  status: LinkStatus;
  onOpenTask: (taskId: string) => void;
  onOpenSession: (session: SessionRow) => void;
}) {
  const [view, setView] = useState<View>("sessions");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const tasks = history(model, filter);
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            setRefreshKey((k) => k + 1);
            void (client?.checkAgents() ?? Promise.resolve()).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Title eyebrow="Your work">{view === "sessions" ? "Sessions" : "malves tasks"}</Title>
      <Choices<View>
        options={[
          { value: "sessions", label: "Sessions" },
          { value: "tasks", label: "malves tasks" },
        ]}
        value={view}
        onChange={setView}
      />
      {view === "sessions" ? (
        <SessionsList
          client={client}
          status={status}
          onOpen={onOpenSession}
          refreshKey={refreshKey}
        />
      ) : (
        <>
          <Choices options={FILTERS} value={filter} onChange={setFilter} />
          {tasks.length === 0 ? <Text style={styles.muted}>{EMPTY[filter]}</Text> : null}
          {tasks.length > 0 ? (
            <List>
              {tasks.map((t) => (
                <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
              ))}
            </List>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
