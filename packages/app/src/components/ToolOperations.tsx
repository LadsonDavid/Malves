import type { ToolProgress } from "@malves/protocol";
import { useState } from "react";
import { Text, View } from "react-native";
import { groupOperations } from "../operations";
import { Button, Card, styles } from "../ui";

export function ToolOperations({
  operations,
  finished = false,
  recorded = false,
}: {
  operations: ToolProgress[];
  finished?: boolean;
  recorded?: boolean;
}) {
  return (
    <View>
      {groupOperations(operations).map((group) => (
        <OperationGroup
          key={group[0]?.id}
          operations={group}
          finished={finished}
          recorded={recorded}
        />
      ))}
    </View>
  );
}
function OperationGroup({
  operations,
  finished,
  recorded,
}: {
  operations: ToolProgress[];
  finished: boolean;
  recorded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const first = operations[0];
  if (operations.length === 1 && first)
    return <Operation tool={first} finished={finished} recorded={recorded} />;
  return (
    <Card>
      <Button
        title={`${open ? "Hide" : "Show"} ${operations.length} completed reads/searches`}
        kind="plain"
        onPress={() => setOpen(!open)}
      />
      {open
        ? operations.map((tool) => (
            <Operation key={tool.id} tool={tool} finished={finished} recorded={recorded} />
          ))
        : null}
    </Card>
  );
}
function Operation({
  tool,
  finished,
  recorded,
}: {
  tool: ToolProgress;
  finished: boolean;
  recorded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const state =
    tool.status === "completed"
      ? "Completed"
      : tool.status === "failed"
        ? "Failed"
        : recorded
          ? "No result in this saved snapshot"
          : finished
            ? "Interrupted before completion"
            : tool.status === "in_progress"
              ? "Running"
              : "Pending";
  return (
    <Card>
      <Text style={styles.body} selectable>
        {tool.title}
      </Text>
      <Text style={styles.muted}>
        {recorded ? "Recorded: " : ""}
        {state}
      </Text>
      {tool.text ? (
        <>
          <Button
            title={open ? "Hide output" : "Show output"}
            kind="plain"
            onPress={() => setOpen(!open)}
          />
          {open ? (
            <Text style={styles.mono} selectable>
              {tool.text}
            </Text>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
