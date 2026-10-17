import wrtc from "@roamhq/wrtc";

/**
 * The computer's screen as real video (WebRTC), for the phone's live view.
 * Each frame is grabbed (nut.js), turned into I420 and handed to WebRTC,
 * which encodes and sends it; about 15 frames a second at the screen's own
 * size. Setup (offer, answer) travels over the sealed link; the video itself
 * goes straight between phone and computer (over Tailscale: no server).
 */
export type Grab = () => Promise<{ width: number; height: number; rgba: Uint8Array }>;

const FPS = 15;

/** The addresses in an SDP, for serve.log (no ports, so nothing sensitive beyond local IPs). */
function addresses(sdp: string): string {
  const found = [...sdp.matchAll(/a=candidate:\S+ \d+ (\w+) \d+ (\S+) \d+ typ (\w+)/g)].map(
    (m) => `${m[2]} ${m[1]} ${m[3]}`,
  );
  return found.length ? [...new Set(found)].join(", ") : "no addresses";
}

/** The shape of an SDP (media lines and codecs), for serve.log: no keys or passwords. */
function shape(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter((l) => l.startsWith("m=")).join(" | ");
  const codecs = [
    ...new Set(lines.map((l) => l.match(/^a=rtpmap:\d+ ([\w-]+)/)?.[1]).filter(Boolean)),
  ];
  return `${media || "no media line"}; codecs: ${codecs.join(", ") || "none"}`;
}

export class ScreenVideo {
  private peer: InstanceType<typeof wrtc.RTCPeerConnection> | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly grab: Grab,
    /** Each step, to serve.log: where a failed video stopped. */
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Answers the phone's offer and starts streaming; one viewer at a time. */
  async start(offerSdp: string): Promise<{ sdp: string; width: number; height: number }> {
    this.stop();
    const first = await this.grab();
    const source = new wrtc.nonstandard.RTCVideoSource({ isScreencast: true });
    const peer = new wrtc.RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    peer.addTrack(source.createTrack());
    // Diagnosis: which addresses the phone offered (a 100.x one means it can use Tailscale).
    this.log(`Video: the phone offered ${addresses(offerSdp)}. Offer: ${shape(offerSdp)}.`);
    peer.oniceconnectionstatechange = () =>
      this.log(`Video: connection test ${peer.iceConnectionState}.`);
    peer.onconnectionstatechange = () => {
      this.log(`Video: ${peer.connectionState}.`);
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) this.stop(peer);
    };
    await peer.setRemoteDescription({ type: "offer", sdp: offerSdp });
    await peer.setLocalDescription(await peer.createAnswer());
    // No trickle: wait (briefly) until every candidate is in the answer.
    await new Promise<void>((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      const done = setTimeout(resolve, 3000);
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") {
          clearTimeout(done);
          resolve();
        }
      };
    });

    const { width, height } = first;
    const i420 = new Uint8Array(width * height * 1.5);
    let busy = false;
    this.timer = setInterval(() => {
      if (busy) return; // a slow grab skips a frame instead of piling up
      busy = true;
      void this.grab()
        .then((f) => {
          if (f.width !== width || f.height !== height) return;
          wrtc.nonstandard.rgbaToI420(
            { width, height, data: f.rgba },
            { width, height, data: i420 },
          );
          source.onFrame({ width, height, data: i420 });
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 1000 / FPS);
    this.log(
      `Video: answered the phone (${width}x${height}, ${addresses(peer.localDescription?.sdp ?? "")}). Answer: ${shape(peer.localDescription?.sdp ?? "")}.`,
    );
    return { sdp: peer.localDescription?.sdp ?? "", width, height };
  }

  /** Stops streaming (the phone left the screen, or the connection dropped). */
  stop(only?: InstanceType<typeof wrtc.RTCPeerConnection>): void {
    if (only && only !== this.peer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.peer?.close();
    this.peer = undefined;
  }
}
