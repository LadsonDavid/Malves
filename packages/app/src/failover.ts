import type { LinkStatus } from "@malves/protocol";

/** How long the computer must stay unreachable before the phone tries the standby copy. */
export const FAILOVER_AFTER_MS = 6_000;

/**
 * Which runner the app talks to. The computer wins whenever it is online; the
 * standby copy is used only once it has actually connected, so a dead standby
 * never replaces a computer that is merely slow.
 */
export function activeSide(o: {
  primary: LinkStatus;
  standby: LinkStatus;
  failover: boolean;
  hasStandby: boolean;
}): "primary" | "standby" {
  return o.hasStandby && o.failover && o.primary !== "online" && o.standby === "online"
    ? "standby"
    : "primary";
}
