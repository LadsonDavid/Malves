import UnifiedPush, { requestPermissions, subscribeDistributorMessages } from "expo-unified-push";
import { type ComputerView, links } from "./links";

/**
 * Push through UnifiedPush (§4): the runner sends a Web Push message,
 * encrypted to this phone's keys, via ntfy. ntfy only ever sees ciphertext.
 * Push is a hint — if one is lost, the inbox still catches up from the log.
 */

let listening = false;

/** Forwards new registrations to the computer they belong to. Call once at startup. */
export function listenForRegistrations(): void {
  if (listening) return;
  listening = true;
  subscribeDistributorMessages((message) => {
    if (message.action !== "registered") return;
    const { url, pubKey, auth, instance } = message.data;
    links.registerPush(instance, { endpoint: url, p256dh: pubKey, auth }).catch(() => {
      // The computer is offline; registration is retried on the next app start.
    });
  });
}

/** Turns on notifications from one computer. Uses the ntfy app as the distributor. */
export async function enablePush(computer: ComputerView): Promise<void> {
  const vapid = computer.welcome?.vapid_public_key;
  if (!vapid) throw new Error("This computer has push turned off, or isn't connected right now.");
  if ((await requestPermissions()) !== "granted") {
    throw new Error("Notifications are blocked for malves in Android settings.");
  }
  if (!UnifiedPush.getSavedDistributor()) {
    const external = UnifiedPush.getDistributors().find((d) => !d.isInternal);
    if (!external) {
      throw new Error(
        "Install the ntfy app from F-Droid or Google Play first. It delivers malves notifications " +
          "without Google's servers seeing their content.",
      );
    }
    UnifiedPush.saveDistributor(external.id);
  }
  listenForRegistrations();
  // One registration per computer; the instance name routes the endpoint back to it.
  await UnifiedPush.registerDevice(vapid, computer.runnerId);
}
