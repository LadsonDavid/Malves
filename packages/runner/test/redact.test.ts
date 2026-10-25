import { describe, expect, it } from "vitest";
import { LineRedactor, redact } from "../src/redact.js";

const SECRETS: Array<[string, string]> = [
  ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["GitHub fine-grained", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz"],
  ["Anthropic key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
  ["OpenAI key", "sk-proj-0123456789abcdefghijklmnop"],
  ["AWS key id", "AKIAABCDEFGHIJKLMNOP"],
  ["Slack token", "xoxb-1234567890-abcdefghij"],
  ["Google key", "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345"],
  ["Groq key", "gsk_abcdefghijklmnopqrstuvwxyz0123456789"],
  ["Cartesia style key", "sk_car_abcdefghijklmnopqrstuvwxyz"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123"],
];

describe("redact", () => {
  it.each(SECRETS)("hides a %s", (_name, secret) => {
    const out = redact(`error calling the service with ${secret} in the header`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[hidden]");
    expect(out).toContain("error calling the service with");
  });

  it("hides values after key names and bearer tokens", () => {
    expect(redact("api_key=abc123")).not.toContain("abc123");
    expect(redact('{"token":"abc123"}')).not.toContain("abc123");
    expect(redact("password: hunter2")).not.toContain("hunter2");
    expect(redact("Authorization: Bearer abc.def-ghi")).not.toContain("abc.def-ghi");
    expect(redact("x-key: abc123")).not.toContain("abc123");
  });

  it("hides private key blocks", () => {
    const block = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(redact(`key is ${block} done`)).not.toContain("MIIEvQ");
  });

  it("keeps ordinary text, paths and numbers", () => {
    const text =
      "Video: sent 3 frames, 157613 bytes at D:\\Pavilion\\Malves\\key-notes.txt (1920x1080)";
    expect(redact(text)).toBe(text);
  });
});

describe("LineRedactor", () => {
  it("hides a secret split across two chunks", () => {
    const out: string[] = [];
    const lines = new LineRedactor((line) => out.push(line));
    lines.write("token ghp_abcdefghijklmnopqr");
    lines.write("stuvwxyz0123456789 done\nnext line\npartial");
    lines.end();
    expect(out.join("")).not.toContain("ghp_");
    expect(out).toEqual(["token [hidden] done\n", "next line\n", "partial\n"]);
  });

  it("hides a private key spread over several lines", () => {
    const out: string[] = [];
    const lines = new LineRedactor((line) => out.push(line));
    lines.write(
      "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nabcdef\n-----END PRIVATE KEY-----\nafter\n",
    );
    lines.end();
    expect(out).toEqual(["before\n", "[hidden]\n", "after\n"]);
  });
});
