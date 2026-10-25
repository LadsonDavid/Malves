import type { Desktop } from "../assistant/desktop.js";
import { nutDesktop } from "../assistant/desktop.js";
import { type Grab, ScreenVideo } from "./video.js";
import type { FromVideo, ToVideo } from "./video-ipc.js";

/**
 * The video process: it grabs the screen, turns it into video and sends it to
 * the phone, so none of that waits behind everything else the main process is
 * doing (reading sessions, starting agents, answering the phone). The main
 * process starts it with `fork` and talks to it with `video-ipc` messages.
 *
 * MALVES_VIDEO_FAKE=1 makes it film a moving test picture instead of the
 * screen, for tests on a computer with no screen.
 */
const send = (message: FromVideo) => process.send?.(message);

let desktop: Promise<Desktop> | undefined;
const screen = () => {
  desktop ??= nutDesktop();
  return desktop;
};
const grab: Grab =
  process.env.MALVES_VIDEO_FAKE === "1" ? testPicture() : async () => (await screen()).raw();

const video = new ScreenVideo(grab, (line) => send({ t: "log", line }));

process.on("message", (message: ToVideo) => {
  if (message.t === "stop") {
    video.stop();
    return;
  }
  video.start(message.sdp).then(
    (answer) => send({ t: "answer", id: message.id, ...answer }),
    (error: unknown) =>
      send({
        t: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});

// The main process went away: stop filming and leave.
process.on("disconnect", () => {
  video.stop();
  process.exit(0);
});

// Load the screen-grabbing part now, while nobody is waiting for it.
if (process.env.MALVES_VIDEO_FAKE !== "1") screen().catch(() => {});
send({ t: "ready" });

/** 1920x1080 frames with a bar that moves, so every frame differs. */
function testPicture(): Grab {
  const width = 1920;
  const height = 1080;
  const rgba = new Uint8Array(width * height * 4);
  let n = 0;
  return async () => {
    const bar = (n++ * 24) % width;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const inBar = x >= bar && x < bar + 80;
        rgba[i] = inBar ? 255 : (x * 255) / width;
        rgba[i + 1] = inBar ? 255 : (y * 255) / height;
        rgba[i + 2] = inBar ? 255 : 128;
        rgba[i + 3] = 255;
      }
    }
    return { width, height, rgba };
  };
}
