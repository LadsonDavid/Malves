/**
 * Text typed into a window is content, never keystrokes. Control characters
 * (Ctrl+C, Escape, Backspace, Delete, a lone carriage return) could interrupt
 * or edit what's on screen, and invisible or direction-changing characters can
 * make the text differ from what was read back. Line breaks and tabs stay.
 */
export const MAX_TYPED_CHARS = 2000;

// C0 and C1 controls except tab and line feed; zero-width, word-joiner, bidi
// controls and the byte-order mark.
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

export type SafeText = { text: string; dropped: number; cut: boolean };

export function safeTyped(input: string): SafeText {
  const normal = input.replace(/\r\n/g, "\n");
  let dropped = 0;
  let text = normal.replace(UNSAFE, () => {
    dropped += 1;
    return "";
  });
  const cut = text.length > MAX_TYPED_CHARS;
  if (cut) text = text.slice(0, MAX_TYPED_CHARS);
  return { text, dropped, cut };
}
