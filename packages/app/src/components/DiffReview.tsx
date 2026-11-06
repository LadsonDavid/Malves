import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, styles } from "../ui";

/** Unified patches already show before (-) and after (+); keep each file collapsible. */
export function DiffReview({ text }: { text: string }) {
  const parts = text.split(/(?=^diff --git )/m);
  return (
    <View>
      {parts.map((part) =>
        part.startsWith("diff --git ") ? (
          <DiffFile key={part.split("\n", 1)[0]} text={part} />
        ) : (
          <Text key="summary" style={styles.muted} selectable>
            {part}
          </Text>
        ),
      )}
    </View>
  );
}
function DiffFile({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const title = text.split("\n", 1)[0]?.replace(/^diff --git /, "") ?? "Changed file";
  return (
    <View>
      <Button
        title={`${open ? "Hide" : "Show"} ${title}`}
        kind="plain"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <ScrollView horizontal style={{ maxHeight: 420 }}>
          <Text style={styles.mono} selectable>
            {text}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
