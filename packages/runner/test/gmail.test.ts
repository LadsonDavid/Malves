import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Gmail, GmailAccounts, plainText } from "../src/adapters/assistant/gmail.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "malves-gmail-"));
  dirs.push(dir);
  return dir;
};

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A fake Google: records every call and answers the few endpoints used. */
function fakeGoogle() {
  const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body ? { body: String(init.body) } : {}),
      ...(headers.get("authorization") ? { auth: headers.get("authorization") ?? "" } : {}),
    });
    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "access-1", expires_in: 3600 });
    }
    if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
    if (url.includes("/messages/m1?format=metadata")) {
      return json({
        snippet: "Lunch on Friday?",
        payload: {
          headers: [
            { name: "From", value: "Anna <anna@example.com>" },
            { name: "Subject", value: "Lunch" },
            { name: "Date", value: "Fri, 6 Nov 2026 10:00:00 +0000" },
          ],
        },
      });
    }
    if (url.includes("/messages/m2?format=metadata")) {
      return json({ snippet: "x", payload: { headers: [{ name: "Subject", value: "Second" }] } });
    }
    if (url.includes("/messages/m1?format=full")) {
      return json({
        snippet: "Lunch on Friday?",
        payload: {
          headers: [{ name: "Subject", value: "Lunch" }],
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/html", body: { data: b64("<p>HTML <b>version</b></p>") } },
            { mimeType: "text/plain", body: { data: b64("Shall we have lunch on Friday?") } },
          ],
        },
      });
    }
    if (url.endsWith("/drafts")) return json({ id: "d1" });
    return json({}, 404);
  };
  return { http, calls };
}

function setup() {
  const dir = tmp();
  const accounts = new GmailAccounts(dir);
  accounts.add("Me@Example.com", "refresh-secret-123");
  const google = fakeGoogle();
  const gmail = new Gmail({
    accounts,
    clientId: "id",
    clientSecret: "secret",
    fetch: google.http,
  });
  return { dir, accounts, gmail, ...google };
}

describe("Gmail accounts", () => {
  it("keeps refresh tokens encrypted, lists, and removes accounts", () => {
    const dir = tmp();
    const accounts = new GmailAccounts(dir);
    accounts.add("a@example.com", "refresh-secret-123");
    accounts.add("B@example.com", "other-secret-456");
    expect(accounts.list()).toEqual(["a@example.com", "b@example.com"]);
    expect(accounts.token("a@example.com")).toBe("refresh-secret-123");
    // The token file alone shows nothing, and a second reader with the key sees the same.
    const raw = readFileSync(path.join(dir, "gmail-accounts.enc")).toString("latin1");
    expect(raw).not.toContain("refresh-secret-123");
    expect(new GmailAccounts(dir).list()).toHaveLength(2);
    expect(accounts.remove("a@example.com")).toBe(true);
    expect(accounts.remove("a@example.com")).toBe(false);
    expect(accounts.list()).toEqual(["b@example.com"]);
  });
});

describe("Gmail", () => {
  it("asks which account when there are several, and refuses an unknown one", () => {
    const s = setup();
    expect(s.gmail.pick(undefined)).toBe("me@example.com");
    s.accounts.add("second@example.com", "t");
    expect(() => s.gmail.pick(undefined)).toThrow(/Which account/);
    expect(() => s.gmail.pick("stranger@example.com")).toThrow(/isn't connected/);
    expect(s.gmail.pick("SECOND@example.com")).toBe("second@example.com");
  });

  it("searches, reads plain text, and uses one access token for many calls", async () => {
    const s = setup();
    const found = await s.gmail.search("me@example.com", "from:anna");
    expect(found.map((m) => [m.id, m.subject, m.from])).toEqual([
      ["m1", "Lunch", "Anna <anna@example.com>"],
      ["m2", "Second", ""],
    ]);
    const mail = await s.gmail.read("me@example.com", "m1");
    expect(mail.body).toBe("Shall we have lunch on Friday?");
    // One token refresh served the search and the read.
    expect(s.calls.filter((c) => c.url.includes("oauth2.googleapis.com")).length).toBe(1);
    expect(s.calls.find((c) => c.url.includes("/messages?"))?.auth).toBe("Bearer access-1");
    expect(s.calls.find((c) => c.url.includes("/messages?"))?.url).toContain("q=from%3Aanna");
  });

  it("saves a draft without sending, and a header can't be forged with line breaks", async () => {
    const s = setup();
    const id = await s.gmail.draft("me@example.com", {
      to: "anna@example.com",
      subject: "Lunch\r\nBcc: evil@example.com",
      body: "See you Friday.",
    });
    expect(id).toBe("d1");
    const post = s.calls.find((c) => c.url.endsWith("/drafts"));
    const raw = Buffer.from(JSON.parse(post?.body ?? "{}").message.raw, "base64url").toString(
      "utf8",
    );
    expect(raw).toContain("To: anna@example.com");
    expect(raw).toContain("Subject: Lunch Bcc: evil@example.com");
    expect(raw).not.toMatch(/\r\nBcc:/);
    // Nothing in the whole session called a send endpoint.
    expect(s.calls.some((c) => /send/i.test(c.url))).toBe(false);
  });

  it("says so when Google refuses the saved sign-in", async () => {
    const dir = tmp();
    const accounts = new GmailAccounts(dir);
    accounts.add("me@example.com", "revoked");
    const gmail = new Gmail({
      accounts,
      clientId: "id",
      clientSecret: "secret",
      fetch: async () => json({ error: "invalid_grant" }, 400),
    });
    await expect(gmail.search("me@example.com", "x")).rejects.toThrow(/refused the saved sign-in/);
  });

  it("turns HTML mail into text", () => {
    expect(
      plainText({
        mimeType: "text/html",
        body: { data: b64("<style>p{}</style><p>Hello&nbsp;<b>there</b></p><script>x()</script>") },
      }),
    ).toBe("Hello there");
  });
});
