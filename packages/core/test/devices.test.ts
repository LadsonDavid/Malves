import { createCore, PAIRING_TTL_MS, PairingError } from "@malves/core";
import { describe, expect, it } from "vitest";
import { setup } from "./fakes.js";

const phone = { publicKey: "cGhvbmUta2V5", name: "Pixel" };

describe("devices", () => {
  it("pairs a phone with the current one-time secret", () => {
    const c = setup();
    const { secret, expiresAt } = c.devices.startPairing();
    expect(expiresAt).toBe(c.clock.now() + PAIRING_TTL_MS);
    const device = c.devices.completePairing({ secret, ...phone });
    expect(device).toMatchObject({ name: "Pixel", publicKey: phone.publicKey });
    expect(c.devices.byPublicKey(phone.publicKey)?.id).toBe(device.id);
  });

  it("uses the secret up, even when the attempt fails", () => {
    const c = setup();
    const { secret } = c.devices.startPairing();
    expect(() => c.devices.completePairing({ secret: "wrong", ...phone })).toThrow(PairingError);
    expect(() => c.devices.completePairing({ secret, ...phone })).toThrow(PairingError);
    expect(c.devices.list()).toEqual([]);
  });

  it("refuses a secret after 120 seconds", () => {
    const c = setup();
    const { secret } = c.devices.startPairing();
    c.clock.advance(PAIRING_TTL_MS + 1);
    expect(() => c.devices.completePairing({ secret, ...phone })).toThrow(/expired/);
  });

  it("a new code replaces the old one", () => {
    const c = setup();
    const first = c.devices.startPairing();
    c.devices.startPairing();
    expect(() => c.devices.completePairing({ secret: first.secret, ...phone })).toThrow(
      PairingError,
    );
  });

  it("refuses when no pairing was started", () => {
    expect(() => setup().devices.completePairing({ secret: "", ...phone })).toThrow(PairingError);
  });

  it("revokes one phone, and remembers devices across restarts", () => {
    const c = setup();
    const a = c.devices.completePairing({ secret: c.devices.startPairing().secret, ...phone });
    const b = c.devices.completePairing({
      secret: c.devices.startPairing().secret,
      publicKey: "b3RoZXI=",
      name: "Tablet",
    });
    c.devices.registerPush(b.id, { endpoint: "https://ntfy.sh/upX?up=1", p256dh: "k", auth: "a" });
    expect(c.devices.revoke(a.id)).toBe(true);
    const restarted = createCore({ ...c.options, store: c.store });
    expect(restarted.devices.list()).toEqual([
      expect.objectContaining({ id: b.id, push: expect.objectContaining({ auth: "a" }) }),
    ]);
    expect(restarted.devices.byPublicKey(phone.publicKey)).toBeUndefined();
  });

  it("does not log the same push subscription twice", () => {
    const c = setup();
    const d = c.devices.completePairing({ secret: c.devices.startPairing().secret, ...phone });
    const sub = { endpoint: "https://ntfy.sh/upX?up=1", p256dh: "k", auth: "a" };
    c.devices.registerPush(d.id, sub);
    c.devices.registerPush(d.id, sub);
    expect(c.store.events.filter((e) => e.type === "device.push_registered")).toHaveLength(1);
  });
});
