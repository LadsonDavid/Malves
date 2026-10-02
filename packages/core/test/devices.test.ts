import { createCore } from "@malves/core";
import { describe, expect, it } from "vitest";
import { setup } from "./fakes.js";

const KEY_A = `${"A".repeat(43)}=`;
const KEY_B = `${"B".repeat(43)}=`;

describe("devices", () => {
  it("pairs a phone and finds it by its public key", () => {
    const c = setup();
    const phone = c.devices.pair("Pixel 8", KEY_A);
    expect(c.devices.byKey(KEY_A)).toEqual(phone);
    expect(c.devices.byKey(KEY_B)).toBeUndefined();
    expect(c.devices.list()).toEqual([phone]);
  });

  it("pairing the same key again returns the same device", () => {
    const c = setup();
    const first = c.devices.pair("Pixel 8", KEY_A);
    expect(c.devices.pair("Pixel 8 again", KEY_A)).toEqual(first);
    expect(c.devices.list()).toHaveLength(1);
  });

  it("a revoked phone is no longer recognised, and the revocation is logged", () => {
    const c = setup();
    const phone = c.devices.pair("Pixel 8", KEY_A);
    expect(c.devices.revoke(phone.id)).toBe(true);
    expect(c.devices.byKey(KEY_A)).toBeUndefined();
    expect(c.devices.list()).toEqual([]);
    expect(c.devices.revoke(phone.id)).toBe(false);
    expect(c.store.events.map((e) => e.type)).toEqual(["device.paired", "device.revoked"]);
  });

  it("remembers phones and revocations across a restart", () => {
    const c = setup();
    const kept = c.devices.pair("Pixel 8", KEY_A);
    const lost = c.devices.pair("Old phone", KEY_B);
    c.devices.revoke(lost.id);
    const restarted = createCore({ ...c.options, store: c.store });
    expect(restarted.devices.list()).toEqual([kept]);
  });
});
