/**
 * Mouse, keyboard and screen for handover mode, through nut.js (the free
 * community fork, Apache-2.0). Loaded only when handover starts: it takes a
 * few seconds and pulls in native code.
 *
 * Coordinates are the mouse's (logical pixels): screenshots are resized to the
 * screen's logical size, so a point picked on the picture is where the click
 * lands, whatever the display scaling.
 */
export interface Desktop {
  /** The screen as a JPEG, at most 1600 px wide; clicks use this picture's coordinates. */
  screenshot(): Promise<{ jpeg: string; width: number; height: number }>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  /** e.g. "enter", "ctrl+s", "alt+tab". */
  keys(combo: string): Promise<void>;
  mouse(): Promise<{ x: number; y: number }>;
  activeTitle(): Promise<string>;
}

/** Windows that Malves never clicks or types into: IDE agent panels stay ruled out, and sign-ins. */
export const OFF_LIMITS =
  /visual studio code|cursor|antigravity|windsurf|password|sign in|log in|user account control|credential|bank|payment/i;

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
    async mouse() {
      const p = await nut.mouse.getPosition();
      return { x: p.x, y: p.y };
    },
    async activeTitle() {
      return (await (await nut.getActiveWindow()).title) ?? "";
    },
  };
}
