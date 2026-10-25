import type { Alert, Delivery } from "@malves/core";
import type { Caller } from "../assistant/caller.js";
import type { NtfyPush } from "../push/ntfy.js";

/**
 * Routes automation alerts to push notifications (ntfy) and phone calls (Caller)
 * based on alert importance.
 */
export class RunnerDelivery implements Delivery {
  constructor(
    private readonly push?: () => NtfyPush | undefined,
    private readonly caller?: () => Caller | undefined,
  ) {}

  async deliver(alert: Alert): Promise<void> {
    const p = this.push?.();
    const c = this.caller?.();

    if (alert.importance === "call" && c) {
      try {
        await c.call(`${alert.name}: ${alert.text}`);
      } catch (error) {
        console.warn(`Automation delivery call failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (p) {
      try {
        p.notify(alert.name, alert.text);
      } catch (error) {
        console.warn(`Automation delivery push failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log(`[Alert: ${alert.importance}] ${alert.name}: ${alert.text}`);
    }
  }
}
