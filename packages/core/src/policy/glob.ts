/**
 * A glob → regular expression, case-insensitive (Windows paths ignore case).
 *   `**`  anything, including separators
 *   `*`   anything except a separator (paths) / anything at all (command text)
 *   `?`   one character
 */
export function globToRegExp(glob: string, o: { text?: boolean } = {}): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` also matches nothing, so `**/.ssh/**` matches `.ssh/id` too.
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else out += ".*";
      } else out += o.text ? ".*" : "[^/]*";
    } else if (c === "?") out += o.text ? "." : "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** Paths are compared with forward slashes only. */
export function normalizePath(p: string): string {
  return p.replaceAll("\\", "/");
}

export function matchesPath(globs: readonly string[], p: string): boolean {
  const target = normalizePath(p);
  return globs.some((g) => globToRegExp(normalizePath(g)).test(target));
}

export function matchesText(globs: readonly string[], text: string): boolean {
  const target = text.trim().replace(/\s+/g, " ");
  return globs.some((g) => globToRegExp(g, { text: true }).test(target));
}
