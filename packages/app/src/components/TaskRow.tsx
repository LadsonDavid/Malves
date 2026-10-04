import type { TaskState } from "@malves/protocol";
import { Text, View } from "react-native";
import { duration, isFinished, type Model, STATE_WORDS, type Task, workspaceName } from "../model";
import { Card, Chip, styles, type Tone } from "../ui";
import { useNow } from "../useNow";

const STATE_TONE: Record<TaskState, Tone | "plain"> = {
  queued: "plain",
  running: "info",
  waiting: "warn",
  done: "ok",
  failed: "bad",
  stopped: "plain",
};

export function StateChip({ state }: { state: TaskState }) {
  return <Chip label={STATE_WORDS[state]} tone={STATE_TONE[state]} />;
}

/** One task in a list: state, what it was asked, where, and how long. Tap for details. */
export function TaskRow({ task, model, onOpen }: { task: Task; model: Model; onOpen: () => void }) {
  const now = useNow(isFinished(task) ? 60_000 : 1000);
  const last = model.activity[task.id]?.at(-1);
  return (
    <Card onPress={onOpen} label={`${STATE_WORDS[task.state]}: ${task.prompt}`}>
      <View style={[styles.row, { alignItems: "center" }]}>
        <StateChip state={task.state} />
        <Text style={styles.muted}>
          {task.agent} · {workspaceName(model, task.workspaceId)} · {duration(task, now)}
        </Text>
      </View>
      <Text style={styles.body} numberOfLines={2}>
        {task.prompt}
      </Text>
      {!isFinished(task) && last ? (
        <Text style={styles.muted} numberOfLines={1}>
          Now: {last.text}
        </Text>
      ) : null}
      {isFinished(task) && task.reason ? (
        <Text style={styles.muted} numberOfLines={2}>
          {task.reason}
        </Text>
      ) : null}
    </Card>
  );
}
