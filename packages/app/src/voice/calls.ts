import type { LinkClient } from "@malves/protocol";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";

/**
 * Malves calling: the computer sends a content-free push through Google
 * (Firebase) with only a call id; this shows Android's incoming-call screen.
 * Answering opens malves, which asks the computer, over the sealed link, why
 * it called. Loaded first (index.ts), so it also works when the app was closed.
 * Native code (APK only): in Expo Go none of this exists and calls are off.
 */
type CallScreen = typeof import("react-native-full-screen-notification-incoming-call").default;
let callScreen: CallScreen | undefined;
try {
  callScreen = (
    require("react-native-full-screen-notification-incoming-call") as {
      default: CallScreen;
    }
  ).default;
} catch {
  callScreen = undefined;
}

const TASK = "malves-call";
/** Rings for this long, then it's a missed call. */
const RING_MS = 45_000;

let answered: string | undefined;
const listeners = new Set<(callId: string) => void>();

/** The call id from a push, whichever way Android delivered it. */
function callIdOf(payload: unknown): string | undefined {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  let fields: Record<string, unknown> = data;
  if (typeof data.dataString === "string") {
    try {
      fields = JSON.parse(data.dataString) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return fields.type === "call" && typeof fields.call_id === "string" ? fields.call_id : undefined;
}

if (callScreen) {
  const screen = callScreen;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
    if (data && !("actionIdentifier" in data)) {
      const callId = callIdOf(data);
      if (callId) {
        screen.displayNotification(callId, null, RING_MS, {
          channelId: "malves-calls",
          channelName: "Malves calling",
          notificationIcon: "ic_launcher",
          notificationTitle: "Malves",
          notificationBody: "Malves is calling",
          answerText: "Answer",
          declineText: "Decline",
          notificationColor: "#0B1F3A",
        });
      }
    }
    return Notifications.BackgroundNotificationTaskResult.NoData;
  });
  void Notifications.registerTaskAsync(TASK).catch(() => {});
  screen.addEventListener("answer", (event) => {
    screen.backToApp();
    answered = event.callUUID;
    for (const listener of listeners) listener(event.callUUID);
  });
}

/** Calls you answered: right away if one was answered before the app was ready. */
export function onAnsweredCall(listener: (callId: string) => void): () => void {
  listeners.add(listener);
  if (answered) listener(answered);
  return () => listeners.delete(listener);
}

/**
 * Resolves once the phone is unlocked and malves is in front. Answering a call
 * on a locked phone opens malves behind the lock screen: until it's unlocked,
 * Malves says nothing and doesn't listen, so a stranger can't talk to it.
 */
export function whenUnlocked(): Promise<void> {
  if (AppState.currentState === "active") return Promise.resolve();
  return new Promise((resolve) => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      sub.remove();
      resolve();
    });
  });
}

/** The answered call was handled: don't hand it out again. */
export function callHandled(callId: string): void {
  if (answered === callId) answered = undefined;
}

/**
 * Lets the computer ring this phone. Undefined when it worked; otherwise why
 * not (Expo Go, no Firebase file in this build, notifications refused).
 */
export async function registerForCalls(client: LinkClient): Promise<string | undefined> {
  if (!callScreen) return "Calls need the malves app (APK), not Expo Go.";
  try {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return "Allow malves' notifications in Android settings to get calls.";
    const token = await Notifications.getDevicePushTokenAsync();
    const ack = await client.registerCalls(String(token.data));
    return ack.ok ? undefined : (ack.error ?? "The computer didn't take it.");
  } catch {
    return "This app build has no Firebase setup, so it can't be called.";
  }
}
