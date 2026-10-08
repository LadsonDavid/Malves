/**
 * Mouse, keyboard and screen for handover mode and the phone's remote view,
 * through nut.js (the free community fork, Apache-2.0). Loaded only when first
 * needed: it takes a few seconds and pulls in native code.
 *
 * Coordinates are the mouse's (logical pixels): screenshots are resized to the
 * screen's logical size, so a point picked on the picture is where the click
 * lands, whatever the display scaling.
 */
export interface Desktop {
  /** The screen as a JPEG, at most 1600 px wide; clicks use this picture's coordinates. */
  screenshot(): Promise<{ jpeg: string; width: number; height: number }>;
  /** A small, quick picture of the screen for watching it live on the phone (doesn't change click coordinates). */
  preview(): Promise<{ jpeg: string; width: number; height: number }>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  /** e.g. "enter", "ctrl+s", "alt+tab". */
  keys(combo: string): Promise<void>;
  mouse(): Promise<{ x: number; y: number }>;
  /** The whole screen, raw RGBA, for live video. */
  raw(): Promise<{ width: number; height: number; rgba: Uint8Array }>;
  /** For you, from the phone: x and y are fractions of the screen (0 to 1). */
  point(x: number, y: number, button: "move" | "left" | "double" | "right"): Promise<void>;
  /** Positive scrolls down. */
  scroll(lines: number): Promise<void>;
  activeTitle(): Promise<string>;
}

/** Windows that Malves never clicks or types into: sign-ins, passwords, payments, admin prompts. */
// Whole words only: "Riverbank" or "CHANGELOG in" aren't a bank or a sign-in.
export const OFF_LIMITS =
  /\b(password|sign in|sign-in|log in|login|user account control|credentials?|bank(ing)?|payment|checkout)\b/i;

/** Code editors: Malves works there as a co-developer; its read-backs say so. */
export const EDITOR = /visual studio code|cursor|antigravity|windsurf/i;

type Nut = typeof import("@nut-tree-fork/nut-js");

export async function nutDesktop(): Promise<Desktop> {
  const nut: Nut = await import("@nut-tree-fork/nut-js");
  nut.keyboard.config.autoDelayMs = 20;
  nut.mouse.config.autoDelayMs = 20;
  let factor = 1;

  const keyOf = (name: string) => {
    const k = nut.Key as unknown as Record<string, number>;
    const map: Record<string, string> = {
      ctrl: "LeftControl",
      control: "LeftControl",
      shift: "LeftShift",
      alt: "LeftAlt",
      win: "LeftSuper",
      enter: "Enter",
      return: "Enter",
      esc: "Escape",
      escape: "Escape",
      tab: "Tab",
      space: "Space",
      backspace: "Backspace",
      delete: "Delete",
      up: "Up",
      down: "Down",
      left: "Left",
      right: "Right",
      home: "Home",
      end: "End",
      pageup: "PageUp",
      pagedown: "PageDown",
    };
    // "a" → A, "5" → Num5, "f5" → F5.
    const id = map[name] ?? (/^\d$/.test(name) ? `Num${name}` : name.toUpperCase());
    const value = k[id];
    if (value === undefined) throw new Error(`I don't know the key "${name}".`);
    return value;
  };

  return {
    async screenshot() {
      const width = await nut.screen.width();
      const height = await nut.screen.height();
      const picture = await nut.imageToJimp(await nut.screen.grab());
      factor = Math.min(1, 1600 / width);
      picture.resize(Math.round(width * factor), Math.round(height * factor)).quality(60);
      const jpeg = (await picture.getBufferAsync("image/jpeg")).toString("base64");
      return { jpeg, width: picture.getWidth(), height: picture.getHeight() };
    },
    async preview() {
      const picture = await nut.imageToJimp(await nut.screen.grab());
      const scale = Math.min(1, 1000 / picture.getWidth());
      picture
        // Bilinear: about twice as fast as the default, and text stays readable.
        .resize(
          Math.round(picture.getWidth() * scale),
          Math.round(picture.getHeight() * scale),
          "bilinearInterpolation",
        )
        .quality(50);
      const jpeg = (await picture.getBufferAsync("image/jpeg")).toString("base64");
      return { jpeg, width: picture.getWidth(), height: picture.getHeight() };
    },
    async click(x, y) {
      await nut.mouse.setPosition(new nut.Point(Math.round(x / factor), Math.round(y / factor)));
      await nut.mouse.leftClick();
    },
    async type(text) {
      await nut.keyboard.type(text);
    },
    async keys(combo) {
      const keys = combo.toLowerCase().replace(/\s+/g, "").split("+").filter(Boolean).map(keyOf);
      await nut.keyboard.pressKey(...keys);
      await nut.keyboard.releaseKey(...keys.reverse());
    },
    async raw() {
      const image = await (await nut.screen.grab()).toRGB();
      return {
        width: image.width,
        height: image.height,
        rgba: new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.length),
      };
    },
    async point(fx, fy, button) {
      const width = await nut.screen.width();
      const height = await nut.screen.height();
      await nut.mouse.setPosition(
        new nut.Point(Math.round(fx * (width - 1)), Math.round(fy * (height - 1))),
      );
      if (button === "move") return;
      if (button === "right") await nut.mouse.rightClick();
      else if (button === "double") await nut.mouse.doubleClick(nut.Button.LEFT);
      else await nut.mouse.leftClick();
    },
    async scroll(lines) {
      if (lines > 0) await nut.mouse.scrollDown(lines);
      else if (lines < 0) await nut.mouse.scrollUp(-lines);
    },
    async mouse() {
      const p = await nut.mouse.getPosition();
      return { x: p.x, y: p.y };
    },
    async activeTitle() {
      return (await (await nut.getActiveWindow()).title) ?? "";
    },
  };
}
