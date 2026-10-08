import { spawn } from "node:child_process";
import type { ScreenInput } from "@malves/protocol";
import type { Desktop } from "../assistant/desktop.js";
import { ScreenVideo } from "./video.js";

type Frame = { jpeg: string; width: number; height: number };

/**
 * Your computer's screen on the phone, any time: watching it (the next picture
 * captured while the last one travels, about three a second) and controlling it
 * (clicks where you tap, scrolling, typing, keys). It never happens unnoticed:
 * the computer shows a notification when a phone starts watching or takes
 * control. No read-backs here: you are the one deciding each click.
 */
export class RemoteScreen {
  private loading: Promise<Desktop> | undefined;
  private lastFrame = 0;
  private lastInput = 0;
  /** The next picture, started while the last one travels to the phone. */
  private next: { at: number; picture: Promise<Frame> } | undefined;
  private readonly now: () => number;
  private readonly video = new ScreenVideo(async () => (await this.desktop()).raw());

  constructor(
    private readonly o: {
      load: () => Promise<Desktop>;
      /** Shown on the computer itself. */
      notice: (text: string) => void;
      now?: () => number;
    },
  ) {
    this.now = o.now ?? Date.now;
  }

  private desktop(): Promise<Desktop> {
    this.loading ??= this.o.load().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  async frame(): Promise<Frame> {
    // A pause this long means a new viewing: say so on the computer.
    if (this.now() - this.lastFrame > 30_000) this.o.notice("Your phone is watching this screen.");
    this.lastFrame = this.now();
    const d = await this.desktop();
    // A picture taken over a second ago (the phone paused) is too old to show.
    const ready = this.next && this.now() - this.next.at < 1000 ? this.next.picture : d.preview();
    this.next = undefined;
    const picture = await ready;
    // Capture the next one now, so it's ready when the phone asks.
    const upcoming = d.preview();
    upcoming.catch(() => {});
    this.next = { at: this.now(), picture: upcoming };
    return picture;
  }

  /** Live video instead of pictures: answers the phone's WebRTC offer. */
  async startVideo(sdp: string): Promise<{ sdp: string; width: number; height: number }> {
    this.o.notice("Your phone is watching this screen.");
    this.lastFrame = this.now();
    return this.video.start(sdp);
  }

  stopVideo(): void {
    this.video.stop();
  }

  async input(i: Omit<ScreenInput, "type" | "command_id">): Promise<void> {
    if (this.now() - this.lastInput > 60_000)
      this.o.notice("Your phone is controlling this computer.");
    this.lastInput = this.now();
    const d = await this.desktop();
    switch (i.action) {
      case "move":
      case "click":
      case "double":
      case "right":
        if (i.x === undefined || i.y === undefined) throw new Error("Where? A tap needs x and y.");
        return d.point(i.x, i.y, i.action === "click" ? "left" : i.action);
      case "scroll":
        return d.scroll(i.lines ?? 0);
      case "type":
        return d.type(i.text ?? "");
      case "keys":
        return d.keys(i.keys ?? "");
    }
  }
}

/** The Windows notification: PowerShell's own toast, the text passed as data (an environment variable). */
const TOAST = String.raw`
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode('malves')) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:MALVES_NOTICE)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

export function windowsNotice(text: string, log: (line: string) => void): void {
  log(text);
  if (process.platform !== "win32") return;
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", TOAST], {
      env: { ...process.env, MALVES_NOTICE: text },
      windowsHide: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
  } catch {
    // The line in the log stays; a missing notification never breaks the view.
  }
}
