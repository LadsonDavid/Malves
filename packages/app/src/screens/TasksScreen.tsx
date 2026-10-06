import type { LinkClient } from "@malves/protocol";
import { useState } from "react";
import { RefreshControl, ScrollView, Text } from "react-native";
import { TaskRow } from "../components/TaskRow";
import { history, type Model, type TaskFilter } from "../model";
import { Choices, List, styles, Title } from "../ui";

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

/** Every task this computer has run, newest first. */
export function TasksScreen({
  model,
  client,
  onOpenTask,
}: {
  model: Model;
  client: LinkClient | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const tasks = history(model, filter);
  return (
    <ScrollView
      contentContainerStyle={styles.page}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            void (client?.checkAgents() ?? Promise.resolve()).finally(() => setRefreshing(false));
          }}
        />
      }
    >
      <Title eyebrow="History">Tasks</Title>
      <Choices options={FILTERS} value={filter} onChange={setFilter} />
      {tasks.length === 0 ? <Text style={styles.muted}>{EMPTY[filter]}</Text> : null}
      {tasks.length > 0 ? (
        <List>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} model={model} onOpen={() => onOpenTask(t.id)} />
          ))}
        </List>
      ) : null}
    </ScrollView>
  );
}
