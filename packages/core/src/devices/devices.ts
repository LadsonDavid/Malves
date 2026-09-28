import { equalSecrets, type PushSubscription } from "@malves/protocol";
import type { EventLog } from "../events/log.js";
import type { Clock, Ids, Random } from "../ports.js";

export type Device = {
  id: string;
  name: string;
  /** X25519 public key, base64. */
  publicKey: string;
  push?: PushSubscription;
};

export const PAIRING_TTL_MS = 120_000;

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/**
 * Phones paired with this runner (§8). Pairing needs a one-time secret that is
 * shown only in the desktop's QR code and lives for 120 seconds. Each phone
 * has its own key, so one lost phone can be revoked alone.
 */
export class Devices {
  private readonly byId = new Map<string, Device>();
  private invite: { secret: string; expiresAt: number } | undefined;

  constructor(
    private readonly log: EventLog,
    private readonly clock: Clock,
    private readonly ids: Ids,
    private readonly random: Random,
  ) {
    log.subscribe((event) => {
      switch (event.type) {
        case "device.paired": {
          const { device_id: id, name, public_key: publicKey } = event.data;
          this.byId.set(id, { id, name, publicKey });
          break;
        }
        case "device.revoked":
          this.byId.delete(event.data.device_id);
          break;
        case "device.push_registered": {
          const device = this.byId.get(event.data.device_id);
          if (device) device.push = event.data.subscription;
          break;
        }
      }
    });
  }

  /** Creates a new one-time secret. Any earlier one stops working. */
  startPairing(ttlMs = PAIRING_TTL_MS): { secret: string; expiresAt: number } {
    this.invite = { secret: this.random.token(24), expiresAt: this.clock.now() + ttlMs };
    return { ...this.invite };
  }

  /** Called when a phone presents a secret. The secret is used up either way. */
  completePairing(input: { secret: string; publicKey: string; name: string }): Device {
    const invite = this.invite;
    this.invite = undefined;
    if (!invite || !equalSecrets(invite.secret, input.secret)) {
      throw new PairingError("This pairing code is not valid. Show a new one on the computer.");
    }
    if (this.clock.now() > invite.expiresAt) {
      throw new PairingError("This pairing code has expired. Show a new one on the computer.");
    }
    const existing = this.byPublicKey(input.publicKey);
    if (existing) return existing;
    const id = this.ids.next("dev");
    this.log.append({
      type: "device.paired",
      data: { device_id: id, name: input.name, public_key: input.publicKey },
    });
    return this.get(id) as Device;
  }

  byPublicKey(publicKey: string): Device | undefined {
    for (const device of this.byId.values()) {
      if (device.publicKey === publicKey) return { ...device };
    }
    return undefined;
  }

  get(id: string): Device | undefined {
    const device = this.byId.get(id);
    return device && { ...device };
  }

  list(): Device[] {
    return [...this.byId.values()].map((d) => ({ ...d }));
  }

  revoke(id: string): boolean {
    if (!this.byId.has(id)) return false;
    this.log.append({ type: "device.revoked", data: { device_id: id } });
    return true;
  }

  registerPush(deviceId: string, subscription: PushSubscription): void {
    if (!this.byId.has(deviceId)) throw new Error(`Unknown device: ${deviceId}`);
    const current = this.byId.get(deviceId)?.push;
    if (
      current?.endpoint === subscription.endpoint &&
      current.p256dh === subscription.p256dh &&
      current.auth === subscription.auth
    ) {
      return;
    }
    this.log.append({
      type: "device.push_registered",
      data: { device_id: deviceId, subscription },
    });
  }
}
