import type { LoggedEvent } from "@malves/protocol";
import { describe, expect, it } from "vitest";
import { auditLines } from "../src/audit.js";

const at = (iso: string) => new Date(iso).getTime();
const event = (seq: number, iso: string, body: object) =>
  ({ seq, at: at(iso), ...body }) as unknown as LoggedEvent;

describe("who took the computer", () => {
  const names = (id: string) => (id === "d1" ? "Pixel 8" : undefined);

  it("lists watching, controlling and handover, oldest first, with the phone's name", () => {
    const lines = auditLines(
      [
        event(1, "2026-10-25T10:00:00", { type: "task.created", data: {} }),
        event(2, "2026-10-25T10:05:00", {
          type: "control.started",
          data: { kind: "screen_view", device_id: "d1" },
        }),
        event(3, "2026-10-25T10:06:00", {
          type: "control.started",
          data: { kind: "screen_control", device_id: "d1" },
        }),
        event(4, "2026-10-25T11:00:00", { type: "control.started", data: { kind: "handover" } }),
        event(5, "2026-10-25T12:30:00", {
          type: "control.ended",
          data: { kind: "handover", reason: "You took it back." },
        }),
      ],
      names,
    );
    expect(lines).toEqual([
      "2026-10-25 10:05  Pixel 8 watched the screen",
      "2026-10-25 10:06  Pixel 8 controlled the screen (clicks, typing, keys)",
      "2026-10-25 11:00  Malves took the computer (handover)",
      "2026-10-25 12:30  Handover ended: You took it back.",
    ]);
  });

  it("says so for a phone it no longer knows, and when nothing happened", () => {
    expect(
      auditLines(
        [
          event(1, "2026-10-25T10:05:00", {
            type: "control.started",
            data: { kind: "screen_view", device_id: "gone" },
          }),
        ],
        names,
      ),
    ).toEqual(["2026-10-25 10:05  A phone that is no longer paired watched the screen"]);
    expect(auditLines([], names)).toEqual([]);
  });

  it("keeps only the newest when asked for a few", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      event(i + 1, `2026-10-25T10:${String(i).padStart(2, "0")}:00`, {
        type: "control.started",
        data: { kind: "screen_view", device_id: "d1" },
      }),
    );
    const lines = auditLines(many, names, 5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain("10:29");
  });
});
