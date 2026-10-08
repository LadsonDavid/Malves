import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { color, font, space, styles } from "../ui";

/**
 * An agent's reply as it was meant to look: headings, bold, inline code, code
 * blocks and lists, instead of raw `**` and `#`. Only the pieces agents use;
 * anything else shows as plain text.
 */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      for (i += 1; i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```"); i++)
        code.push(lines[i] ?? "");
      blocks.push(
        <Text
          key={i}
          selectable
          style={[
            styles.mono,
            { backgroundColor: color.sunken, padding: space.sm, borderRadius: 8 },
          ]}
        >
          {code.join("\n")}
        </Text>,
      );
      continue;
    }
    if (!line.trim()) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <Text key={i} style={[styles.body, styles.strong]} selectable>
          {inline(heading[1] ?? "")}
        </Text>,
      );
      continue;
    }
    const item = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
    if (item) {
      const marker = /\d/.test(item[2] ?? "") ? item[2] : "•";
      blocks.push(
        <View
          key={i}
          style={{ flexDirection: "row", gap: space.sm, paddingLeft: (item[1]?.length ?? 0) * 4 }}
        >
          <Text style={[styles.body, { color: color.muted }]}>{marker}</Text>
          <Text style={[styles.body, { flex: 1 }]} selectable>
            {inline(item[3] ?? "")}
          </Text>
        </View>,
      );
      continue;
    }
    blocks.push(
      <Text key={i} style={styles.body} selectable>
        {inline(line)}
      </Text>,
    );
  }
  return <View style={{ gap: space.sm }}>{blocks}</View>;
}

/** **bold**, `code` and [links](url) (shown as their text) inside a line. */
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\([^)]+\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    if (m[1] ?? m[2]) {
      parts.push(
        <Text key={at} style={{ fontFamily: font.semibold }}>
          {m[1] ?? m[2]}
        </Text>,
      );
    } else if (m[3]) {
      parts.push(
        <Text key={at} style={{ fontFamily: font.mono, backgroundColor: color.sunken }}>
          {m[3]}
        </Text>,
      );
    } else parts.push(m[4]);
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
