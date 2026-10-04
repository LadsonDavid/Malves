import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Transcriber } from "../src/adapters/voice/whisper.js";

/** Precise dictation: recording pieces in, Whisper (via a fake freellmapi) out. */
const cleanup: Array<() => unknown> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

async function freellmapi(status = 200) {
  const seen: Array<{ req: IncomingMessage; body: Buffer }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ req, body: Buffer.concat(chunks) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "  fix the footer in malves  " }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("precise dictation (Whisper)", () => {
  it("joins the pieces in order and sends them with the language and the key", async () => {
    const api = await freellmapi();
    const t = new Transcriber({ upstream: api.url, key: "real-key" });
    const audio = Buffer.alloc(300_000, 7);
    const b64 = audio.toString("base64");
    for (let i = 0, index = 0; i < b64.length; i += 131_072, index++) {
      t.add("u1", index, b64.slice(i, i + 131_072));
    }
    expect(await t.transcribe("u1", "ta")).toBe("fix the footer in malves");

    const { req, body } = api.seen[0] ?? { req: undefined, body: Buffer.alloc(0) };
    expect(req?.url).toBe("/v1/audio/transcriptions");
    expect(req?.headers.authorization).toBe("Bearer real-key");
    const text = body.toString("latin1");
    expect(text).toContain('name="language"\r\n\r\nta');
    expect(text).toContain('name="model"\r\n\r\nauto');
    expect(text).toContain('filename="speech.wav"');
    expect(body.length).toBeGreaterThan(300_000); // the whole recording went
    // Used once: the recording is gone afterwards.
    await expect(t.transcribe("u1", "en")).rejects.toThrow(/isn't on the computer/);
  });

  it("refuses pieces out of order, and recordings that are too long", () => {
    const t = new Transcriber({ upstream: "http://127.0.0.1:9", key: "k" });
    expect(() => t.add("u2", 1, "AAAA")).toThrow(/isn't on the computer/);
    t.add("u3", 0, "AAAA");
    expect(() => t.add("u3", 2, "AAAA")).toThrow(/went missing/);
    const big = Buffer.alloc(1_000_000).toString("base64");
    t.add("u4", 0, big);
    t.add("u4", 1, big);
    expect(() => t.add("u4", 2, big)).toThrow(/too long/);
  });

  it("says plainly when freellmapi fails", async () => {
    const api = await freellmapi(500);
    const t = new Transcriber({ upstream: api.url, key: "k" });
    t.add("u5", 0, "AAAA");
    await expect(t.transcribe("u5", "en")).rejects.toThrow("freellmapi answered 500");
  });
});
