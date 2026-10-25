/**
 * 64-bit FNV-1a, as 16 hex characters. Only for noticing that a monitor's output
 * changed; it is not a security hash.
 */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * What changed between two outputs: lines gone (`-`) and lines new (`+`), at
 * most `max` characters. Order is ignored; a monitor cares what appeared.
 */
export function lineDiff(before: string, after: string, max: number): string {
  const was = before.split("\n");
  const now = after.split("\n");
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const lines = [
    ...was.filter((l) => !nowSet.has(l)).map((l) => `- ${l}`),
    ...now.filter((l) => !wasSet.has(l)).map((l) => `+ ${l}`),
  ];
  return clip(lines.join("\n"), max);
}

/** `{{name}}`-style placeholders; an unknown name is left as it is, so a typo is visible. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => vars[name] ?? whole);
}
