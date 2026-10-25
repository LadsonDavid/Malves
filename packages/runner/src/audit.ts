import type { LoggedEvent } from "@malves/protocol";

/**
 * "Who took my computer, and when": the control events in the log (a phone
 * watching or controlling the screen, Malves taking over in handover mode),
 * one plain line each, oldest first. For `malves audit` and `audit` in serve.
 */
export function auditLines(
  events: LoggedEvent[],
  deviceName: (id: string) => string | undefined,
  newest = 20,
): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "control.started") {
      const who = e.data.device_id
        ? (deviceName(e.data.device_id) ?? "A phone that is no longer paired")
        : "Malves";
      const what =
        e.data.kind === "screen_view"
          ? `${who} watched the screen`
          : e.data.kind === "screen_control"
            ? `${who} controlled the screen (clicks, typing, keys)`
            : `${who} took the computer (handover)`;
      lines.push(`${stamp(e.at)}  ${what}`);
    } else if (e.type === "control.ended") {
      lines.push(`${stamp(e.at)}  Handover ended${e.data.reason ? `: ${e.data.reason}` : ""}`);
    }
  }
  return lines.slice(-newest);
}

/** Local time, "2026-10-25 10:05". */
function stamp(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
