import type { Device, Notifier, OpenQuestion } from "@malves/core";
import type { PushSubscription } from "@malves/protocol";
import webpush from "web-push";
import type { Secrets } from "../secrets/secrets.js";

export type Vapid = { publicKey: string; privateKey: string };

/** The VAPID key pair identifies this runner to push services. Kept in the keychain. */
export function loadVapid(secrets: Secrets): Vapid {
  const publicKey = secrets.get("vapid-public-key");
  const privateKey = secrets.get("vapid-private-key");
  if (publicKey && privateKey) return { publicKey, privateKey };
  const keys = webpush.generateVAPIDKeys();
  secrets.set("vapid-public-key", keys.publicKey);
  secrets.set("vapid-private-key", keys.privateKey);
  return keys;
}

/** What the phone's native renderer reads (see modules/malves-notify). Kept under 4 KB. */
export type PushPayload =
  | {
      kind: "question";
      runner: string;
      from: string;
      q: string;
      t: string;
      text: string;
      risk: string;
      choices: Array<{ id: string; label: string }>;
      exp: number;
    }
  | { kind: "closed"; runner: string; q: string }
  | { kind: "digest"; runner: string; title: string; text: string };

export type WebPushOptions = {
  devices: () => Device[];
  runnerId: string;
  name: string;
  vapid: Vapid;
  now?: () => number;
};

const SUBJECT = "https://github.com/LadsonDavid/Malves";

/**
 * Push through UnifiedPush and ntfy (§4). Each message is Web Push encrypted
 * (RFC 8291, aes128gcm) to the phone's own keys, so ntfy — public ntfy.sh in
 * topology A — only ever sees ciphertext. Push is a hint: a failure is
 * reported, never retried forever, and never affects the question itself.
 */
export class WebPushNotifier implements Notifier {
  constructor(private readonly o: WebPushOptions) {}

  async questionOpened(q: OpenQuestion): Promise<void> {
    await this.broadcast(
      {
        kind: "question",
        runner: this.o.runnerId,
        from: this.o.name,
        q: q.question_id,
        t: q.task_id,
        text: clip(q.text, 1000),
        risk: q.risk,
        choices: q.choices.slice(0, 3).map((c) => ({ id: c.id, label: clip(c.label, 40) })),
        exp: q.expires_at,
      },
      Math.max(0, Math.round((q.expires_at - (this.o.now ?? Date.now)()) / 1000)),
    );
  }

  /** Clears the notification on the phone once the question is answered elsewhere or times out. */
  async questionClosed(questionId: string): Promise<void> {
    await this.broadcast({ kind: "closed", runner: this.o.runnerId, q: questionId }, 3600);
  }

  /** A counts-only digest, e.g. from the lead engine (R7). */
  async digest(title: string, text: string): Promise<void> {
    await this.broadcast({ kind: "digest", runner: this.o.runnerId, title, text }, 24 * 3600);
  }

  private async broadcast(payload: PushPayload, ttlSeconds: number): Promise<void> {
    const targets = this.o.devices().flatMap((d) => (d.push ? [d.push] : []));
    if (targets.length === 0) return;
    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      targets.map((sub) => this.sendOne(sub, body, ttlSeconds)),
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === targets.length) {
      throw new Error(`push failed: ${String((failed[0] as PromiseRejectedResult).reason)}`);
    }
  }

  private async sendOne(sub: PushSubscription, body: string, ttl: number): Promise<void> {
    if (!allowedEndpoint(sub.endpoint)) throw new Error("push endpoint must use https");
    // web-push builds the encrypted request; fetch sends it, so a self-hosted
    // ntfy over plain http inside the tailnet works too.
    const request = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      {
        vapidDetails: {
          subject: SUBJECT,
          publicKey: this.o.vapid.publicKey,
          privateKey: this.o.vapid.privateKey,
        },
        TTL: ttl,
        urgency: "high",
        contentEncoding: "aes128gcm",
      },
    );
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers: request.headers as Record<string, string>,
      body: request.body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`push service answered ${response.status}`);
  }
}

/**
 * Endpoints come from paired phones only, but the runner still refuses plain
 * http except to loopback or a tailnet address (a self-hosted ntfy over Tailscale).
 */
export function allowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
