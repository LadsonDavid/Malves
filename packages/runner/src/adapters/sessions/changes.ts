import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isSecretPath } from "@malves/core";

const execute = promisify(execFile);
const LIMIT = 60_000;

/** Current tracked workspace edits, never a claim of ownership by one chat. */
export async function sessionChanges(folder: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  const git = async (args: string[]) =>
    (
      await execute("git", ["-C", folder, ...args], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 10_000,
        maxBuffer: 256_000,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout;
  try {
    if ((await git(["rev-parse", "--is-inside-work-tree"])).trim() !== "true") throw new Error();
  } catch {
    throw new Error("This session folder isn't an accessible Git repository.");
  }
  let base = ["HEAD"];
  try {
    await git(["rev-parse", "--verify", "HEAD"]);
  } catch {
    base = ["--cached"];
  }
  const names = (
    await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--relative",
      "--name-only",
      "-z",
      ...base,
      "--",
      ".",
    ])
  )
    .split("\0")
    .filter(Boolean);
  const safe = names.filter((name) => !isSecretPath(name) && !/(^|[\\/])ladson\.md$/i.test(name));
  const excluded = names.length - safe.length;
  let text =
    "Workspace changes · not attributed to this chat.\nTracked files only; untracked file contents are omitted.\n";
  if (base[0] === "--cached")
    text += "No commits yet: showing staged changes only; unstaged changes are omitted.\n";
  if (excluded) text += `${excluded} sensitive file(s) excluded.\n`;
  if (!safe.length) return `${text}\nNo tracked changes available to display.`;
  for (const name of safe.slice(0, 100)) {
    if (Date.now() > deadline)
      return `${text}\n… Review time limit reached; open the computer for the rest.`;
    try {
      text += await git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--relative",
        "--no-color",
        ...base,
        "--",
        name,
      ]);
    } catch {
      text += "\n(A file's diff could not be displayed; inspect it on the computer.)\n";
    }
    if (text.length > LIMIT)
      return `${text.slice(0, LIMIT)}\n… Review truncated; open the computer for the rest.`;
  }
  if (safe.length > 100) text += "\n… File limit reached; open the computer for the rest.";
  return text;
}
