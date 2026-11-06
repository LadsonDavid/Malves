import type { RecordedSession, ToolProgress } from "@malves/protocol";
import { redact } from "../../redact.js";

/** Stored evidence only. Never reconstruct an actionable approval from a rollout. */
export function codexRecording(text: string, observedAt: number): RecordedSession {
  const calls = new Map<string, ToolProgress>();
  const results = new Map<string, string>();
  let recorded: RecordedSession["recorded_state"] = "unknown";
  for (const line of text.split("\n")) {
    let raw: { type?: string; payload?: Record<string, unknown> };
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const p = raw.payload;
    if (!p || typeof p !== "object") continue;
    if (raw.type === "event_msg") {
      if (p.type === "task_started") recorded = "started";
      if (p.type === "task_complete") recorded = "completed";
      if (p.type === "turn_aborted") recorded = "interrupted";
    }
    if (raw.type !== "response_item" || typeof p.call_id !== "string") continue;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : "Native operation";
      let title = name;
      let kind: ToolProgress["kind"] = /apply_patch|edit|write/.test(name) ? "edit" : "other";
      if (/exec_command|shell_command/.test(name) && typeof p.arguments === "string") {
        try {
          const args = JSON.parse(p.arguments) as { cmd?: unknown; command?: unknown };
          const cmd = args.cmd ?? args.command;
          if (typeof cmd === "string") {
            title = cmd;
            kind = /^\s*(rg|grep|findstr)\b/.test(cmd)
              ? "search"
              : /^\s*(cat|type|Get-Content|ls|dir)\b/i.test(cmd)
                ? "read"
                : "command";
          }
        } catch {
          /* Preserve the operation name, never guess malformed arguments. */
        }
      }
      calls.set(p.call_id, {
        id: p.call_id,
        title: redact(title).slice(0, 500),
        kind,
        status: "pending",
      });
    }
    if (
      (p.type === "function_call_output" || p.type === "custom_tool_call_output") &&
      typeof p.output === "string"
    )
      results.set(p.call_id, p.output);
  }
  for (const [id, output] of results) {
    const call = calls.get(id);
    if (!call) continue;
    const failed = /(?:Process exited with code|Exit code:)\s*[1-9]\d*\b/i.test(output);
    calls.set(id, {
      ...call,
      status: failed ? "failed" : "completed",
      text: redact(output).slice(0, 2000),
    });
  }
  return {
    provenance: "saved-rollout",
    observed_at: observedAt,
    recorded_state: recorded,
    operations: [...calls.values()].slice(-20),
  };
}
