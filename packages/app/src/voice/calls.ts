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

/** The fields of a push, whichever way Android delivered it. */
function fieldsOf(payload: unknown): Record<string, unknown> | undefined {
  const data = (payload as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  if (typeof data.dataString !== "string") return data;
  try {
    return JSON.parse(data.dataString) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The call id from a push, if it is a call. */
function callIdOf(payload: unknown): string | undefined {
  const fields = fieldsOf(payload);
  return fields?.type === "call" && typeof fields.call_id === "string" ? fields.call_id : undefined;
}

/**
 * Malves' own notifications: the computer sends a data push (type "note") with a
 * title and a link, and this shows it as an Android notification. Tapping it
 * opens the link (App.tsx). The question or task text is never in the push.
 */
const NOTE_CHANNEL = "malves-notes";
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function showNote(fields: Record<string, unknown>): Promise<void> {
  const title = typeof fields.title === "string" ? fields.title.slice(0, 80) : "Malves";
  const body = typeof fields.body === "string" ? fields.body.slice(0, 140) : "Tap to open malves.";
  // Only our own links: a push can't send you anywhere else.
  const link =
    typeof fields.link === "string" && fields.link.startsWith("malves://")
      ? fields.link
      : "malves://home";
  await Notifications.setNotificationChannelAsync(NOTE_CHANNEL, {
    name: "Malves",
    importance: Notifications.AndroidImportance.HIGH,
  }).catch(() => {});
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { link } },
    trigger: { channelId: NOTE_CHANNEL },
  });
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if (data && !("actionIdentifier" in data)) {
    const fields = fieldsOf(data);
    if (fields?.type === "note") await showNote(fields).catch(() => {});
    const callId = callIdOf(data);
    if (callId && callScreen) {
      callScreen.displayNotification(callId, null, RING_MS, {
        // A new id: Android fixes a channel's sound when it is first created.
        channelId: "malves-calls-ring",
        channelName: "Malves calling",
        notificationIcon: "ic_launcher",
        notificationTitle: "Malves",
        notificationBody: "Malves is calling",
        answerText: "Answer",
        declineText: "Decline",
        // No notificationColor: the library wants a colour *resource name*; a hex
        // value isn't found and its ringing service crashes the app.
      });
    }
  }
  return Notifications.BackgroundNotificationTaskResult.NoData;
});
void Notifications.registerTaskAsync(TASK).catch(() => {});

if (callScreen) {
  const screen = callScreen;
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
