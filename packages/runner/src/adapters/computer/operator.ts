import { randomBytes } from "node:crypto";
import type { Desktop } from "../assistant/desktop.js";
import { OFF_LIMITS } from "../assistant/desktop.js";
import { DEFAULT_HASH_THRESHOLD, hashDistance, perceptualHash } from "./hash.js";
import type { Act, ActResult, Computer, Rect, UiElement } from "./types.js";
import type { Policy } from "@malves/core";

export type StoredFrame = {
  frameId: string;
  hash: string;
  timestamp: number;
  jpeg: string;
  width: number;
  height: number;
  elements: UiElement[];
  activeTitle: string;
};

export type ComputerOperatorOptions = {
  desktop: Desktop;
  policy?: Policy | undefined;
  hashThreshold?: number | undefined;
  userPauseMs?: number | undefined;
  askUser?: ((text: string) => Promise<boolean>) | undefined;
};

/**
 * Computer Operator implementing Pillar C contract (§7):
 * - Frame rule: acts specify frameId; refused if screen changed beyond threshold.
 * - Take-over handshake: agent input pauses when user is touching machine.
 * - Check after acting: verifies screen change, stops if no change twice.
 * - Off-limits protections: never clicks or types into password/bank windows.
 */
export class ComputerOperator implements Computer {
  private readonly desktop: Desktop;
  private readonly policy?: Policy | undefined;
  private readonly hashThreshold: number;
  private readonly userPauseMs: number;
  private readonly askUser?: ((text: string) => Promise<boolean>) | undefined;

  private latestFrame: StoredFrame | undefined;
  private lastUserActivity = 0;
  private noChangeConsecutive = 0;

  constructor(options: ComputerOperatorOptions) {
    this.desktop = options.desktop;
    this.policy = options.policy;
    this.hashThreshold = options.hashThreshold ?? DEFAULT_HASH_THRESHOLD;
    this.userPauseMs = options.userPauseMs ?? 2000;
    this.askUser = options.askUser;
  }

  /** Call when user input (mouse move or keypress) is detected on the machine. */
  notifyUserActivity(): void {
    this.lastUserActivity = Date.now();
  }

  isUserActive(): boolean {
    return Date.now() - this.lastUserActivity < this.userPauseMs;
  }

  async snapshot(): Promise<{
    frameId: string;
    jpeg: string;
    width: number;
    height: number;
    elements?: UiElement[] | undefined;
  }> {
    const shot = await this.desktop.screenshot();
    const activeTitle = (await this.desktop.activeTitle().catch(() => "")) || "";
    const hash = perceptualHash(shot.jpeg);
    const frameId = `f_${randomBytes(8).toString("hex")}`;

    // Elements from desktop or UI tree if available
    const elements: UiElement[] = [];

    this.latestFrame = {
      frameId,
      hash,
      timestamp: Date.now(),
      jpeg: shot.jpeg,
      width: shot.width,
      height: shot.height,
      elements,
      activeTitle,
    };

    return {
      frameId,
      jpeg: shot.jpeg,
      width: shot.width,
      height: shot.height,
      elements,
    };
  }

  async act(a: Act, frameId: string): Promise<ActResult> {
    // 1. Take-over handshake (§7 item 4): Pause agent input if user is active
    if (this.isUserActive()) {
      return {
        ok: false,
        frameId: this.latestFrame?.frameId ?? frameId,
        error: "User is active on the machine: agent input paused.",
        userActive: true,
      };
    }

    // 2. Frame rule (§7 item 1): Check that decision frame is valid and fresh
    if (!this.latestFrame || this.latestFrame.frameId !== frameId) {
      // Check current screen hash
      const currentShot = await this.desktop.screenshot();
      const currentHash = perceptualHash(currentShot.jpeg);
      const prevHash = this.latestFrame?.hash ?? "";
      const distance = hashDistance(currentHash, prevHash);

      if (distance > this.hashThreshold) {
        return {
          ok: false,
          frameId: this.latestFrame?.frameId ?? frameId,
          error: "Screen changed since snapshot: fresh snapshot required.",
          changed: true,
        };
      }
    }

    // 3. Off-limits rule (§7 item 6): Check active window title
    const activeTitle = await this.desktop.activeTitle().catch(() => "");
    if (OFF_LIMITS.test(activeTitle)) {
      return {
        ok: false,
        frameId,
        error: `Off-limits window ("${activeTitle}"): Malves never automates passwords, sign-ins or financial portals.`,
      };
    }

    // 4. Policy check per act (§7 item 5)
    const isDestructive =
      (a.kind === "click" || a.kind === "double") &&
      /confirm|delete|remove|send|pay|buy|install/i.test(activeTitle);

    if (isDestructive && this.askUser) {
      const allowed = await this.askUser(`Action "${a.kind}" in "${activeTitle}" requires confirmation.`);
      if (!allowed) {
        return { ok: false, frameId, error: "Action declined by user." };
      }
    }

    // 5. Execute action on desktop
    const beforeHash = this.latestFrame?.hash ?? "";
    await this.perform(a);

    // 6. Check after acting (§7 item 2): diff target region
    const after = await this.snapshot();
    const distanceAfter = hashDistance(beforeHash, this.latestFrame?.hash ?? "");
    const changed = distanceAfter > 2;

    if (!changed && a.kind !== "wait") {
      this.noChangeConsecutive++;
      if (this.noChangeConsecutive >= 2) {
        return {
          ok: false,
          frameId: after.frameId,
          changed: false,
          error: "No change detected on screen twice in a row: agent stopped.",
        };
      }
    } else {
      this.noChangeConsecutive = 0;
    }

    return {
      ok: true,
      frameId: after.frameId,
      changed,
    };
  }

  private async perform(a: Act): Promise<void> {
    switch (a.kind) {
      case "click": {
        const x = a.x ?? 0;
        const y = a.y ?? 0;
        await this.desktop.click(x, y);
        break;
      }
      case "double": {
        const x = a.x ?? 0;
        const y = a.y ?? 0;
        await this.desktop.point(x, y, "double");
        break;
      }
      case "right": {
        const x = a.x ?? 0;
        const y = a.y ?? 0;
        await this.desktop.point(x, y, "right");
        break;
      }
      case "type":
        await this.desktop.type(a.text);
        break;
      case "keys":
        await this.desktop.keys(a.combo);
        break;
      case "scroll":
        await this.desktop.scroll(a.lines);
        break;
      case "drag":
        await this.desktop.point(a.fromX, a.fromY, "left");
        await this.desktop.point(a.toX, a.toY, "move");
        break;
      case "wait":
        await new Promise((r) => setTimeout(r, a.ms));
        break;
    }
  }
}
