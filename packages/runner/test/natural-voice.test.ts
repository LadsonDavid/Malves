import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiCompatible } from "../src/adapters/assistant/llm.js";
import {
  langOf,
  naturalVoice,
  sentences,
  splitSentences,
  voiceFor,
} from "../src/adapters/assistant/voice.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanup.splice(0)) await fn();
});

/** A fake of every provider; `answers` says what each one replies, in turn. */
function providers(answers: Record<string, number[]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const name = String(url).includes("cartesia")
      ? "cartesia"
      : String(url).includes("elevenlabs")
        ? "elevenlabs"
        : "piper";
    calls.push(
      `${name}:${JSON.parse(String(init?.body)).voice?.id ?? JSON.parse(String(init?.body)).voice ?? ""}`,
    );
    const status = answers[name]?.shift() ?? 500;
    return new Response(status === 200 ? `${name}-audio` : "Payment required: no credits left", {
      status,
    });
  });
  return calls;
}

function voice(month = "2026-10-07") {
  const dir = mkdtempSync(path.join(tmpdir(), "malves-voice-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return naturalVoice({
    cartesiaKey: "c",
    elevenlabsKey: "e",
    piperUrl: "http://100.64.0.1:5005",
    stateFile: path.join(dir, "voice-credits.json"),
    now: () => new Date(month),
  });
}

describe("Malves' natural voice", () => {
  it("cuts streamed text into the same sentences as the finished text", () => {
    const text = "Done: footer fixed. Tests pass! Shall I push it?\nசரி, நான் பார்க்கிறேன். ok va";
    const cut = sentences();
    const streamed = [...text].flatMap((ch) => cut.push(ch));
    expect([...streamed, ...cut.flush()]).toEqual(splitSentences(text));
    expect(splitSentences(text)).toEqual([
      "Done: footer fixed.",
      "Tests pass!",
      "Shall I push it?",
      "சரி, நான் பார்க்கிறேன்.",
      "ok va",
    ]);
  });

  it("reads Tamil script in the Tamil voice and Tanglish in the English one", () => {
    expect(langOf("நான் பார்க்கிறேன்")).toBe("ta");
    expect(langOf("Codex la test add pannren")).toBe("en");
    expect(voiceFor("en", { en: "en-female-1" }).name).toBe("Female 1");
    expect(voiceFor("ta", true).name).toBe("Male");
    expect(voiceFor("ta", { ta: "nobody" }).name).toBe("Male");
  });

  it("falls back Cartesia → ElevenLabs → Piper, and skips a used-up one for the month", async () => {
    const calls = providers({ cartesia: [402], elevenlabs: [200, 200], piper: [] });
    const say = voice();
    if (!say) throw new Error("no voice");

    const first = await say("Hello there.", "en", { en: "en-female-2" });
    expect(first.audio.toString()).toBe("elevenlabs-audio");
    expect(first.mime).toBe("audio/mpeg");
    expect(first.note).toBe("Cartesia's free voice is used up this month; using ElevenLabs.");

    const second = await say("Again.", "en", true);
    expect(second.note).toBeUndefined();
    // Cartesia isn't asked again this month.
    expect(calls).toEqual([
      "cartesia:f6141af3-5f94-418c-80ed-a45d450e7e2e",
      "elevenlabs:",
      "elevenlabs:",
    ]);
  });

  it("uses Piper's WAV when both clouds fail, and gives up (for the phone) when all do", async () => {
    providers({ cartesia: [500, 500], elevenlabs: [503, 503], piper: [200, 500] });
    const say = voice();
    if (!say) throw new Error("no voice");
    expect(await say("வணக்கம்", "ta", true)).toMatchObject({ mime: "audio/wav" });
    await expect(say("வணக்கம்", "ta", true)).rejects.toThrow("No natural voice answered.");
  });

  it("is off when no provider is set up", () => {
    expect(naturalVoice({ stateFile: "x" })).toBeUndefined();
  });
});

describe("brain streaming", () => {
  async function brain(events: unknown[]) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise((r) => server.close(r)));
    const { port } = server.address() as AddressInfo;
    return openAiCompatible({ url: `http://127.0.0.1:${port}`, key: "k" });
  }
  const delta = (d: unknown) => ({ choices: [{ delta: d }] });

  it("passes words on as they come and returns the whole reply", async () => {
    const llm = await brain([delta({ content: "Tests " }), delta({ content: "pass." })]);
    const seen: string[] = [];
    const reply = await llm.chat([{ role: "user", content: "hi" }], [], (d) => seen.push(d));
    expect(seen).toEqual(["Tests ", "pass."]);
    expect(reply).toEqual({ content: "Tests pass.", toolCalls: [] });
  });

  it("assembles a tool call and stops passing words on once one starts", async () => {
    const llm = await brain([
      delta({ content: "Okay. " }),
      delta({
        tool_calls: [{ index: 0, id: "c1", function: { name: "stop_task", arguments: '{"ta' } }],
      }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'sk":"t1"}' } }] }),
      delta({ content: "Stopping it now." }),
    ]);
    const seen: string[] = [];
    const reply = await llm.chat([{ role: "user", content: "stop it" }], [], (d) => seen.push(d));
    expect(seen).toEqual(["Okay. "]);
    expect(reply.toolCalls).toEqual([
      { id: "c1", type: "function", function: { name: "stop_task", arguments: '{"task":"t1"}' } },
    ]);
  });
});
