import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

/**
 * Gmail, several accounts, with the narrowest door Google offers for this job:
 * read mail, and save drafts. There is no send call anywhere in this file. (The
 * "compose" permission Google requires for drafts can technically send too, so
 * the safety is in the code: nothing here sends, and a draft is only saved after
 * he says yes to a read-back.)
 *
 * Refresh tokens are encrypted at rest (AES-256-GCM) with a key kept in a
 * separate file, so the token file alone is useless. Email text is data from
 * strangers: it is handed to the brain inside <data> and never acted on.
 *
 * You need your own Google Cloud OAuth client ("Desktop app" type):
 *   MALVES_GOOGLE_CLIENT_ID, MALVES_GOOGLE_CLIENT_SECRET
 * then `malves gmail add` once per account.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const MAX_BODY = 6000;

type Fetch = typeof fetch;
export type Mail = { id: string; from: string; subject: string; date: string; snippet: string };

/** The accounts and their refresh tokens, encrypted on disk. */
export class GmailAccounts {
  private readonly file: string;
  private readonly keyFile: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "gmail-accounts.enc");
    this.keyFile = path.join(dataDir, "gmail.key");
  }

  private key(): Buffer {
    if (existsSync(this.keyFile))
      return Buffer.from(readFileSync(this.keyFile, "utf8").trim(), "hex");
    const key = randomBytes(32);
    mkdirSync(path.dirname(this.keyFile), { recursive: true });
    writeFileSync(this.keyFile, key.toString("hex"), { mode: 0o600 });
    return key;
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = readFileSync(this.file);
      const decipher = createDecipheriv("aes-256-gcm", this.key(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(accounts: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(accounts), "utf8"), cipher.final()]);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, Buffer.concat([iv, cipher.getAuthTag(), body]), { mode: 0o600 });
  }

  list(): string[] {
    return Object.keys(this.read()).sort();
  }

  token(email: string): string | undefined {
    return this.read()[email.toLowerCase()];
  }

  add(email: string, refreshToken: string): void {
    this.write({ ...this.read(), [email.toLowerCase()]: refreshToken });
  }

  remove(email: string): boolean {
    const all = this.read();
    if (!(email.toLowerCase() in all)) return false;
    delete all[email.toLowerCase()];
    this.write(all);
    return true;
  }
}

export class Gmail {
  private readonly cache = new Map<string, { token: string; until: number }>();
  private readonly http: Fetch;

  constructor(
    private readonly o: {
      accounts: GmailAccounts;
      clientId: string;
      clientSecret: string;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {
    this.http = o.fetch ?? fetch;
  }

  accounts(): string[] {
    return this.o.accounts.list();
  }

  /** The account to use: the named one, or the only one. */
  pick(email: string | undefined): string {
    const all = this.accounts();
    if (all.length === 0) throw new Error("No Gmail account is connected. Run `malves gmail add`.");
    if (email) {
      const found = all.find((a) => a === email.toLowerCase());
      if (!found) throw new Error(`That account isn't connected. Connected: ${all.join(", ")}.`);
      return found;
    }
    const [only] = all;
    if (all.length > 1 || !only) throw new Error(`Which account? Connected: ${all.join(", ")}.`);
    return only;
  }

  private async access(email: string): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    const hit = this.cache.get(email);
    if (hit && hit.until > now + 30_000) return hit.token;
    const refresh = this.o.accounts.token(email);
    if (!refresh)
      throw new Error("That account has no saved sign-in. Run `malves gmail add` again.");
    const res = await this.http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.o.clientId,
        client_secret: this.o.clientSecret,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !json.access_token)
      throw new Error("Google refused the saved sign-in. Run `malves gmail add` again.");
    this.cache.set(email, {
      token: json.access_token,
      until: now + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }

  private async get<T>(email: string, url: string): Promise<T> {
    const res = await this.http(url, {
      headers: { authorization: `Bearer ${await this.access(email)}` },
    });
    if (!res.ok) throw new Error(`Gmail answered ${res.status}.`);
    return (await res.json()) as T;
  }

  /** Newest first. `query` is Gmail's own search syntax. */
  async search(email: string, query: string, max = 8): Promise<Mail[]> {
    const q = new URLSearchParams({
      q: query.slice(0, 300),
      maxResults: String(Math.min(max, 15)),
    });
    const list = await this.get<{ messages?: Array<{ id: string }> }>(
      email,
      `${API}/messages?${q}`,
    );
    const out: Mail[] = [];
    for (const { id } of list.messages ?? []) {
      const m = await this.get<Message>(
        email,
        `${API}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      out.push({
        id,
        from: header(m, "From"),
        subject: header(m, "Subject"),
        date: header(m, "Date"),
        snippet: (m.snippet ?? "").slice(0, 200),
      });
    }
    return out;
  }

  /** One message as plain text, cut short. */
  async read(email: string, id: string): Promise<Mail & { body: string }> {
    const m = await this.get<Message>(
      email,
      `${API}/messages/${encodeURIComponent(id)}?format=full`,
    );
    return {
      id,
      from: header(m, "From"),
      subject: header(m, "Subject"),
      date: header(m, "Date"),
      snippet: (m.snippet ?? "").slice(0, 200),
      body: plainText(m.payload).slice(0, MAX_BODY),
    };
  }

  /** Saves a draft in that account. It is never sent from here. */
  async draft(email: string, mail: { to: string; subject: string; body: string }): Promise<string> {
    const raw = [
      `To: ${clean(mail.to)}`,
      `Subject: ${clean(mail.subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      mail.body,
    ].join("\r\n");
    const res = await this.http(`${API}/drafts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.access(email)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: { raw: Buffer.from(raw, "utf8").toString("base64url") } }),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    if (!res.ok || !json.id) throw new Error(`Gmail wouldn't save the draft (${res.status}).`);
    return json.id;
  }
}

type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: Array<{ name: string; value: string }>;
};
type Message = { snippet?: string; payload?: Part };

function header(m: Message, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** A header value cannot carry a line break (that would let text add headers). */
const clean = (s: string) =>
  s
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 300);

/** The text/plain part if there is one, otherwise the HTML with tags removed. */
export function plainText(part: Part | undefined): string {
  if (!part) return "";
  const find = (p: Part, type: string): string | undefined => {
    if (p.mimeType === type && p.body?.data)
      return Buffer.from(p.body.data, "base64url").toString("utf8");
    for (const child of p.parts ?? []) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return undefined;
  };
  const text = find(part, "text/plain");
  if (text) return text.trim();
  const html = find(part, "text/html") ?? "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `malves gmail add`: sign in once in the browser. A one-time code returns to a
 * tiny server on this computer (PKCE, no client secret in the URL), is traded
 * for a refresh token, and the account's address is read from Gmail itself.
 */
export async function connectAccount(o: {
  accounts: GmailAccounts;
  clientId: string;
  clientSecret: string;
  show: (url: string) => void;
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<string> {
  const http = o.fetch ?? fetch;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for Google.")),
        o.timeoutMs ?? 180_000,
      );
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirect);
        if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
          res.writeHead(400).end("Not the sign-in I was waiting for.");
          return;
        }
        res
          .writeHead(200, { "content-type": "text/plain" })
          .end("Connected. You can close this tab.");
        clearTimeout(timer);
        resolve(url.searchParams.get("code") ?? "");
      });
      o.show(
        `${AUTH_URL}?${new URLSearchParams({
          client_id: o.clientId,
          redirect_uri: redirect,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })}`,
      );
    });
    const res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: o.clientId,
        client_secret: o.clientSecret,
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        grant_type: "authorization_code",
      }),
    });
    const tokens = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!res.ok || !tokens.access_token || !tokens.refresh_token)
      throw new Error(
        "Google didn't give a long-lived sign-in. Try again and accept every permission.",
      );
    const profile = await http(`${API}/profile`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const email = ((await profile.json().catch(() => ({}))) as { emailAddress?: string })
      .emailAddress;
    if (!email) throw new Error("Couldn't read the account's address from Gmail.");
    o.accounts.add(email, tokens.refresh_token);
    return email.toLowerCase();
  } finally {
    server.close();
  }
}
