/**
 * Your coding sessions in every tool on this computer, read from where each
 * tool keeps them: Claude Code, Codex, Cursor and Antigravity. One list, newest
 * first, so the phone needs no "projects": the folders come from the sessions.
 */
export type Tool = "claude" | "codex" | "cursor" | "antigravity";

/**
 * How a session can be continued from the phone:
 * - "resume": the tool's own agent picks the conversation up (Claude Code, Codex);
 * - "bridge": sent into the open editor's chat (Cursor's Desktop Bridge);
 * - "new": a fresh session in the same folder, told what happened so far.
 */
export type ContinueHow = "resume" | "bridge" | "new";

export type SessionInfo = {
  tool: Tool;
  id: string;
  title: string;
  /** The folder it ran in, when known. */
  folder?: string | undefined;
  /** Milliseconds since 1970. */
  updatedAt: number;
  how: ContinueHow;
  /** e.g. "editor" for Cursor's and Antigravity's own chats. */
  source?: string | undefined;
};

export type SessionMessage = { who: "you" | "agent"; text: string };

export interface SessionSource {
  readonly tool: Tool;
  list(): Promise<SessionInfo[]>;
  /** The conversation, oldest first (the last `limit` messages). */
  read(id: string, limit: number): Promise<SessionMessage[]>;
}

/** First line of a message, trimmed, as a fallback title. */
export function titleFrom(text: string | undefined, fallback: string): string {
  const line = (text ?? "")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? fallback).slice(0, 120);
}
