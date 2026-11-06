import { describe, expect, it } from "vitest";
import { activeSide } from "../src/failover";

const base = { primary: "offline", standby: "online", failover: true, hasStandby: true } as const;

describe("which runner the app talks to", () => {
  it("uses the standby copy only when it is connected and the computer is not", () => {
    expect(activeSide(base)).toBe("standby");
    // The computer wins the moment it is back.
    expect(activeSide({ ...base, primary: "online" })).toBe("primary");
    // A standby that has not connected never replaces the computer.
    expect(activeSide({ ...base, standby: "connecting" })).toBe("primary");
    expect(activeSide({ ...base, standby: "offline" })).toBe("primary");
    // Not tried yet (the computer was only unreachable for a moment), or no standby paired.
    expect(activeSide({ ...base, failover: false })).toBe("primary");
    expect(activeSide({ ...base, hasStandby: false })).toBe("primary");
  });
});
