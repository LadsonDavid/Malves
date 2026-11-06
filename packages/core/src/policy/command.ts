import path from "node:path";
import type { Classification } from "./types.js";

/**
 * The deterministic command classifier (plan F1, step 2). It generalises
 * `commandRisk` in the runner's handover.ts: plain words only, nothing that can
 * hide a second command, paths inside the project, and a table of known verbs.
 *
 * It never trusts the text. What it can't place is `unknown`: tier 3, and the
 * only thing an advisor model may ever lower.
 */

/** Files that hold secrets: never touched without asking, even inside the project. */
const SECRET =
  /(^|[\\/])(\.env\b|[^\\/]*\.(key|pem|pfx|p12)$|id_[a-z0-9]+$|\.npmrc$|\.netrc$|[^\\/]*(secret|credential|token|password)[^\\/]*$|.*keys?\.txt$)/i;

export function isSecretPath(p: string): boolean {
  return SECRET.test(p);
}

/** Whether `p` (absolute or relative to `root`) lands inside `root`. `~` and other drives never do. */
export function insideRoot(p: string, root: string): boolean {
  if (p.startsWith("~")) return false;
  const rooted = /^[a-z]:/i.test(p) || p.startsWith("\\\\");
  // A drive path on a system that has no drives is somebody else's path, not ours.
  if (rooted && !path.isAbsolute(p)) return false;
  const rel = path.relative(root, path.resolve(root, p));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

/** A command argument that leaves the project, or reaches a secret. Looks inside `--flag=value`. */
function leaves(arg: string, root: string): boolean {
  const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
  if (arg.startsWith("-") && !arg.includes("=")) return false;
  return (
    isSecretPath(value) || !insideRoot(value, root) || /(^|[\\/])\.\.([\\/]|$)/.test(value) // climbing out is refused even if it lands back inside
  );
}

/** Nothing but plain words: brackets, quotes, variables, chaining, pipes and redirection can hide a command. */
const PLAIN = /^[\w\s.\-/\\:=,+@*~]+$/;

/** Verbs that change the machine, reach the network or run other programs: always tier 3. */
const DANGEROUS = new Set([
  "rm",
  "del",
  "erase",
  "rmdir",
  "rd",
  "remove-item",
  "ri",
  "format",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "restart-computer",
  "stop-computer",
  "sudo",
  "su",
  "runas",
  "chmod",
  "chown",
  "icacls",
  "takeown",
  "reg",
  "regedit",
  "setx",
  "net",
  "netsh",
  "sc",
  "taskkill",
  "kill",
  "pkill",
  "stop-process",
  "curl",
  "wget",
  "invoke-webrequest",
  "iwr",
  "irm",
  "invoke-restmethod",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "pulumi",
  "ansible",
  "aws",
  "gcloud",
  "az",
  "mv",
  "move",
  "move-item",
  "mi",
  "cp",
  "copy",
  "copy-item",
  "invoke-expression",
  "iex",
  "eval",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "sh",
  "npx",
  "start",
  "start-process",
  "set-content",
  "add-content",
  "out-file",
  "new-item",
]);

/** Look-only verbs. Their paths were already checked to be inside the project and not secrets. */
const READ = new Set([
  "ls",
  "dir",
  "pwd",
  "cat",
  "type",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "rg",
  "grep",
  "findstr",
  "select-string",
  "head",
  "tail",
  "wc",
  "tree",
  "where",
  "which",
  "get-command",
  "echo",
  "date",
  "hostname",
  "whoami",
]);

const t1 = (why: string): Classification => ({ tier: 1, why });
const t2 = (why: string): Classification => ({ tier: 2, why });
const t3 = (why: string): Classification => ({ tier: 3, why });
const unknown = (why: string): Classification => ({ tier: 3, why, unknown: true });

export function classifyCommand(command: string, root: string): Classification {
  const text = command.trim();
  if (!text) return t3("An empty command can't be judged.");
  if (!PLAIN.test(text)) {
    return t3(
      "It has chaining, redirection, quotes or substitution, which can hide a second command.",
    );
  }
  const words = text.split(/\s+/);
  const first = words[0] ?? "";
  const args = words.slice(1);
  if (/[\\/]/.test(first)) return unknown("It runs a program by its path.");
  if (args.some((a) => leaves(a, root))) {
    return t3("It points outside the project, or at a secret.");
  }
  const verb = first.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");

  if (DANGEROUS.has(verb))
    return t3(`\`${verb}\` changes the machine or reaches out; it always asks.`);
  if (verb === "git") return git(args);
  if (verb === "gh") return gh(args);
  if (verb === "pnpm" || verb === "npm" || verb === "yarn" || verb === "bun") {
    return packageManager(verb, args);
  }
  if (READ.has(verb)) {
    // `rg --pre cmd` runs a program on every file.
    return args.some((a) => /^--pre\b/i.test(a))
      ? unknown("`--pre` runs a program.")
      : t1("It only looks.");
  }
  return tool(verb, args);
}

function git(args: string[]): Classification {
  // `git -C other`, `git -c core.x=y`, `--git-dir`: the repository or behaviour is not the project's.
  if (args[0]?.startsWith("-"))
    return t3("A git option before the command changes where or how it runs.");
  const sub = (args[0] ?? "").toLowerCase();
  const rest = args.slice(1).map((a) => a.toLowerCase());
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a));
  switch (sub) {
    case "status":
    case "log":
    case "diff":
    case "show":
    case "rev-parse":
    case "ls-files":
    case "blame":
    case "describe":
    case "shortlog":
      return rest.some((a) => a === "-o" || a.startsWith("--output"))
        ? t3("`--output` writes a file.")
        : t1("git only reads here.");
    case "branch": {
      const listing = ["-a", "-r", "-v", "-vv", "--list", "--show-current"];
      if (rest.every((a) => listing.includes(a))) return t1("It only lists branches.");
      if (rest.some((a) => /^-(d|m|c|f)$/.test(a) || /^--(delete|move|copy|force)/.test(a))) {
        return t3("It deletes, renames or forces a branch.");
      }
      return t2("A new branch is easy to remove.");
    }
    case "remote":
      return rest.length === 0 || (rest.length === 1 && has("-v"))
        ? t1("It only lists remotes.")
        : t3("It changes remotes.");
    case "tag":
      return rest.length === 0 || has("-l", "--list")
        ? t1("It only lists tags.")
        : t3("It creates or deletes a tag.");
    case "stash":
      if (rest[0] === "list" || rest[0] === "show") return t1("It only lists stashes.");
      return rest.length === 0 || rest[0] === "push"
        ? t2("A stash can be popped again.")
        : t3("It drops or applies a stash.");
    case "add":
      return t2("Staging can be undone.");
    case "commit":
      return has("--amend") ? t3("`--amend` rewrites a commit.") : t2("A commit can be reverted.");
    case "switch":
      return has("-c", "--create")
        ? t2("A new branch is easy to remove.")
        : t3("It changes the working files.");
    case "checkout":
      return rest[0] === "-b"
        ? t2("A new branch is easy to remove.")
        : t3("It can overwrite working files.");
    case "fetch":
      return t2("It downloads; no working file changes.");
    case "worktree":
      if (rest[0] === "add") return t2("A worktree can be removed.");
      return rest[0] === "list"
        ? t1("It only lists worktrees.")
        : t3("It removes or moves a worktree.");
    case "push":
    case "pull":
    case "reset":
    case "clean":
    case "rebase":
    case "merge":
    case "cherry-pick":
    case "revert":
    case "restore":
    case "rm":
    case "mv":
    case "gc":
    case "filter-branch":
    case "submodule":
    case "apply":
    case "am":
    case "config":
      return t3(`\`git ${sub}\` changes history, the remote or many files; it always asks.`);
    default:
      return unknown(`\`git ${sub}\` isn't in the known list.`);
  }
}

const GH_READ = new Set([
  "run list",
  "run view",
  "pr list",
  "pr view",
  "pr status",
  "pr checks",
  "pr diff",
  "issue list",
  "issue view",
  "issue status",
  "repo view",
  "auth status",
  "workflow list",
  "workflow view",
]);

function gh(args: string[]): Classification {
  const key = `${args[0] ?? ""} ${args[1] ?? ""}`.toLowerCase();
  return GH_READ.has(key)
    ? t1("It only reads from GitHub.")
    : t3("`gh` changes things on GitHub, or can't be judged.");
}

/** Flags whose next word is their value (so it isn't taken for the command). */
const PM_VALUE_FLAGS = new Set([
  "--filter",
  "-f",
  "-c",
  "--dir",
  "--prefix",
  "--workspace",
  "-w",
  "--cwd",
]);
const PM_LISTING = new Set(["ls", "list", "outdated", "why", "view", "info", "-v", "--version"]);
const PM_CHANGES = new Set([
  "install",
  "i",
  "add",
  "ci",
  "remove",
  "rm",
  "uninstall",
  "update",
  "up",
  "upgrade",
  "link",
  "unlink",
  "rebuild",
  "prune",
  "dedupe",
  "patch",
  "publish",
  "pack",
  "exec",
  "dlx",
  "x",
  "create",
  "init",
  "login",
  "logout",
  "deploy",
  "config",
]);
const SAFE_SCRIPT =
  /^(test|lint|build|typecheck|check|format|format:check|tsc|vitest|jest|compile|coverage|(test|lint|build|check|typecheck|format):[\w:-]+)$/;
const RISKY_SCRIPT = /migrat|deploy|publish|release|drop|reset|seed|destroy|prod|clean|wipe|push/i;

function packageManager(verb: string, args: string[]): Classification {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (PM_VALUE_FLAGS.has(a.toLowerCase())) i++;
    else if (!(a.startsWith("-") && a !== "-v")) words.push(a.toLowerCase());
    else if (a === "-v") words.push(a);
  }
  const cmd = words[0] ?? "";
  if (args.some((a) => a === "--version")) return t1("It prints a version.");
  if (PM_LISTING.has(cmd)) return t1("It only lists.");
  if (PM_CHANGES.has(cmd)) {
    return t3(`\`${verb} ${cmd}\` installs, publishes or runs other code; it always asks.`);
  }
  const script = cmd === "run" || cmd === "run-script" ? (words[1] ?? "") : cmd;
  if (!script) return unknown("No script named.");
  if (RISKY_SCRIPT.test(script))
    return t3(`The script "${script}" sounds like it changes something outside the project.`);
  if (SAFE_SCRIPT.test(script)) return t2("Tests, lint and builds can be re-run.");
  return unknown(`The script "${script}" isn't one of the known safe ones.`);
}

function tool(verb: string, args: string[]): Classification {
  const first = (args[0] ?? "").toLowerCase();
  const build = t2("Tests, lint and builds can be re-run.");
  switch (verb) {
    case "node":
      return args.length === 1 && (first === "-v" || first === "--version")
        ? t1("It prints a version.")
        : unknown("It runs a script.");
    case "pytest":
    case "vitest":
    case "jest":
    case "eslint":
    case "prettier":
      return build;
    case "python":
    case "python3":
    case "py":
      return first === "-m" && (args[1] ?? "").toLowerCase() === "pytest"
        ? build
        : unknown("It runs a script.");
    case "tsc":
      return build;
    case "biome":
      return ["check", "format", "lint", "ci"].includes(first)
        ? build
        : unknown("Unknown biome command.");
    case "cargo":
      if (["test", "build", "check", "clippy", "fmt", "doc", "bench"].includes(first)) return build;
      return ["install", "publish", "login", "yank"].includes(first)
        ? t3("It installs or publishes.")
        : unknown("Unknown cargo command.");
    case "go":
      if (["test", "build", "vet", "fmt"].includes(first)) return build;
      return ["list", "version"].includes(first)
        ? t1("It only lists.")
        : unknown("Unknown go command.");
    case "dotnet":
      return ["test", "build"].includes(first) ? build : unknown("Unknown dotnet command.");
    case "mvn":
    case "mvnw":
    case "gradle":
    case "gradlew":
      return ["test", "verify", "build", "check", "compile"].includes(first)
        ? build
        : unknown("Unknown build goal.");
    default:
      return unknown(`\`${verb}\` isn't in the known list.`);
  }
}
