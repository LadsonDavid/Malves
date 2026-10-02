import type { EventLog } from "../events/log.js";
import type { Ids } from "../ports.js";

export type Device = { id: string; name: string; publicKey: string };

/**
 * Phones paired with this runner (§8 "Pairing"). A phone is known only by its
 * public key; revoking it is logged and takes effect immediately.
 */
export class Devices {
  private readonly byId = new Map<string, Device>();

  constructor(
    private readonly log: EventLog,
    private readonly ids: Ids,
  ) {
    log.subscribe((event) => {
      if (event.type === "device.paired") {
        const { device_id: id, name, public_key: publicKey } = event.data;
        this.byId.set(id, { id, name, publicKey });
      } else if (event.type === "device.revoked") {
        this.byId.delete(event.data.device_id);
      }
    });
  }

  /** Records a newly paired phone. The caller has already checked the pairing code. */
  pair(name: string, publicKey: string): Device {
    const existing = this.byKey(publicKey);
    if (existing) return existing;
    const id = this.ids.next("dev");
    this.log.append({
      type: "device.paired",
      data: { device_id: id, name, public_key: publicKey },
    });
    return { id, name, publicKey };
  }

  revoke(id: string): boolean {
    if (!this.byId.has(id)) return false;
    this.log.append({ type: "device.revoked", data: { device_id: id } });
    return true;
  }

  byKey(publicKey: string): Device | undefined {
    return this.list().find((d) => d.publicKey === publicKey);
  }

  list(): Device[] {
    return [...this.byId.values()];
  }
}
