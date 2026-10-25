import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import wrtc from "@roamhq/wrtc";
import { describe, expect, it } from "vitest";
import { forkVideoWorker, VideoProcess } from "../src/adapters/screen/video-process.js";

/**
 * The whole live-video path with nothing made up except the picture: the real
 * video process (a moving test picture instead of the screen), real WebRTC, and
 * a "phone" that receives the video and counts the frames. It runs only once the
 * runner has been built (`tsc -b`, which the typecheck step does first).
 */
const worker = fileURLToPath(new URL("../dist/adapters/screen/video-worker.js", import.meta.url));

describe.skipIf(!existsSync(worker))("live video, end to end", () => {
  it("connects through the video process and keeps frames flowing", {
    timeout: 60_000,
  }, async () => {
    process.env.MALVES_VIDEO_FAKE = "1";
    const log: string[] = [];
    const video = new VideoProcess({
      spawn: () => forkVideoWorker(worker),
      log: (l) => log.push(l),
    });
    const phone = new wrtc.RTCPeerConnection({ iceServers: [] });
    let frames = 0;
    let sink: InstanceType<typeof wrtc.nonstandard.RTCVideoSink> | undefined;
    phone.ontrack = (event: { track: unknown }) => {
      sink = new wrtc.nonstandard.RTCVideoSink(event.track as never);
      sink.onframe = () => {
        frames += 1;
      };
    };
    try {
      // The phone's side, as the app does it: offer, wait for the addresses, no trickle.
      phone.addTransceiver("video", { direction: "recvonly" });
      await phone.setLocalDescription(await phone.createOffer());
      await new Promise<void>((resolve) => {
        if (phone.iceGatheringState === "complete") return resolve();
        phone.onicegatheringstatechange = () => phone.iceGatheringState === "complete" && resolve();
        setTimeout(resolve, 3_000);
      });

      const answer = await video.start(phone.localDescription?.sdp ?? "");
      expect(answer).toMatchObject({ width: 1920, height: 1080 });
      await phone.setRemoteDescription({ type: "answer", sdp: answer.sdp });

      const connected = Date.now();
      while (frames === 0) {
        if (Date.now() - connected > 20_000)
          throw new Error(`No video after 20 s.\n${log.join("\n")}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Then count for a while: a steady stream, not one picture and silence.
      const from = frames;
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 6_000));
      const fps = ((frames - from) / (Date.now() - started)) * 1000;
      console.log(`live video test: ${fps.toFixed(1)} frames a second`);
      expect(fps).toBeGreaterThan(4);
    } finally {
      sink?.stop();
      phone.close();
      video.close();
    }
  });
});
