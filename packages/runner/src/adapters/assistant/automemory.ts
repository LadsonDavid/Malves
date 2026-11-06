import { redact } from "../../redact.js";
import type { Llm } from "./llm.js";
import type { Memory, MemoryKind } from "./memory.js";

/**
 * Remembering without being told. After a normal chat turn, the brain reads
 * only what he said (never an agent's output, a web page or a book passage:
 * those could carry someone else's instructions) and lists lasting things about
 * him: preferences, plans, people, projects, decisions. Each becomes a note in
 * the vault, shown in the Memory screen where he can delete it. A temp chat
 * never gets here.
 */
const KINDS: MemoryKind[] = ["fact", "preference", "person", "project"];
const MIN_WORDS = 6;
const MAX_ITEMS = 3;
/** Text that tries to steer the assistant is not a memory about him. */
const STEERING =
  /\b(ignore|disregard|forget)\b.{0,30}\b(rules|instructions|previous|above)\b|\bsystem prompt\b/i;

const SYSTEM = [
  "You read one message the owner sent to his assistant and list lasting things worth remembering about him.",
  "Keep: preferences, plans, people in his life, his projects, decisions, how he wants the assistant to behave, things that are true about him.",
  "Skip: questions, one-off commands, small talk, passing moods, anything he pasted or quoted from elsewhere, secrets, passwords, numbers of cards or accounts.",
  'Answer with JSON only: {"items":[{"kind":"fact|preference|person|project","title":"up to 6 words","text":"one plain sentence, at most 200 characters"}]}',
  'If nothing is worth keeping, answer {"items":[]}.',
].join("\n");

export class AutoMemory {
  constructor(private readonly o: { llm: Llm; memory: Memory }) {}

  /** Saves what is worth keeping from `said`; returns how many notes were written. */
  async learn(said: string): Promise<number> {
    const text = said.trim().slice(0, 1500);
    if (text.split(/\s+/).length < MIN_WORDS) return 0;
    let items: Array<{ kind: MemoryKind; title: string; text: string }>;
    try {
      const { content } = await this.o.llm.chat(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: `<message>${text}</message>` },
        ],
        [],
      );
      items = parse(content);
    } catch {
      return 0;
    }
    let saved = 0;
    for (const item of items.slice(0, MAX_ITEMS)) {
      try {
        await this.o.memory.remember({
          kind: item.kind,
          title: item.title,
          text: redact(item.text),
          source: "chat",
        });
        saved++;
      } catch {
        // A note that can't be written never breaks the chat.
      }
    }
    return saved;
  }
}

/** The brain's JSON, defensively: wrong shapes, odd kinds and steering text are dropped. */
export function parse(content: string): Array<{ kind: MemoryKind; title: string; text: string }> {
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: Array<{ kind: MemoryKind; title: string; text: string }> = [];
  for (const raw of items) {
    const r = raw as { kind?: unknown; title?: unknown; text?: unknown };
    const text = typeof r.text === "string" ? r.text.trim().slice(0, 200) : "";
    const title = typeof r.title === "string" ? r.title.trim().slice(0, 60) : "";
    const kind = KINDS.find((k) => k === r.kind);
    if (!kind || !text || STEERING.test(text) || STEERING.test(title)) continue;
    out.push({ kind, title: title || text.split(/\s+/).slice(0, 6).join(" "), text });
  }
  return out;
}
