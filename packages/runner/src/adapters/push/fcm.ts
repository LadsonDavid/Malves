import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Firebase Cloud Messaging (HTTP v1), used only to ring the phone for a call.
 * The push carries no content, just a call id: why Malves is calling travels
 * over the sealed link once you answer. Signed with your Firebase project's
 * service-account key (MALVES_FCM_KEY, a JSON file kept out of git).
 */
export type FcmSend = (token: string, data: Record<string, string>) => Promise<void>;

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export function fcmSender(keyFile: string): FcmSend {
  const account = JSON.parse(readFileSync(keyFile, "utf8")) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key)
    throw new Error("MALVES_FCM_KEY isn't a Firebase service-account key.");
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token";
  let access: { token: string; until: number } | undefined;

  const accessToken = async () => {
    if (access && access.until > Date.now() + 60_000) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
      iss: account.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(account.private_key, "base64url");
    const response = await fetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !json.access_token)
      throw new Error(`Google refused the Firebase key (${response.status}).`);
    access = { token: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return access.token;
  };

  return async (token, data) => {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          "content-type": "application/json",
        },
        // Data only (so the app shows its own call screen), high priority, and
        // useless after a minute: a call that rings late is worse than none.
        body: JSON.stringify({
          message: { token, data, android: { priority: "HIGH", ttl: "60s" } },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Firebase answered ${response.status}: ${text.slice(0, 160)}`);
    }
  };
}
