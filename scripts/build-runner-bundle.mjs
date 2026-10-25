// Builds malves-windows.zip: the runner with its own Node.js and every package it
// needs, so a Windows user installs nothing first (no Node, pnpm, git or build).
//
//   pnpm exec tsc -b && node scripts/build-runner-bundle.mjs
//
// Windows only, and built with the Node it ships: the native parts (SQLite and
// friends) are compiled for that exact Node, which is why node.exe goes in the zip.
// Output: .bundle/malves-windows.zip and .bundle/malves-windows.zip.sha256
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error(
    "The bundle is for Windows: build it on Windows (the native parts are per platform).",
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".bundle");
const app = path.join(out, "app");
const zip = path.join(out, "malves-windows.zip");
const workspace = path.join(root, "pnpm-workspace.yaml");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// `pnpm deploy` refuses a patch that none of the runner's packages use (the phone app's
// call-screen patch), so the patch list is left out for this one command and put back after.
const original = readFileSync(workspace, "utf8");
try {
  writeFileSync(workspace, original.replace(/^patchedDependencies:\r?\n(?: {2}.*\r?\n)+/m, ""));
  // Hoisted: plain folders and no links, so the zip can be unpacked anywhere.
  const deploy = spawnSync(
    `pnpm --filter @malves/runner --config.node-linker=hoisted deploy --prod --legacy "${app}"`,
    { cwd: root, stdio: "inherit", shell: true },
  );
  if (deploy.status !== 0) throw new Error("pnpm deploy failed");
} finally {
  writeFileSync(workspace, original);
}

for (const leftover of ["src", "test", "tsconfig.json", "tsconfig.tsbuildinfo"]) {
  rmSync(path.join(app, leftover), { recursive: true, force: true });
}
copyFileSync(process.execPath, path.join(app, "node.exe"));
copyFileSync(path.join(root, "scripts", "windows", "malves.cmd"), path.join(app, "malves.cmd"));
copyFileSync(path.join(root, "LICENSE"), path.join(app, "LICENSE"));
writeFileSync(path.join(app, "NODE-VERSION"), `${process.version}\n`);

// Windows' own tar.exe (bsdtar) writes zip files with -a. Not the first `tar` on PATH: Git for
// Windows brings a GNU tar that can't.
const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const pack = spawnSync(tar, ["-a", "-c", "-f", zip, "-C", app, "."], { stdio: "inherit" });
if (pack.status !== 0) throw new Error("tar couldn't make the zip");

const hash = createHash("sha256").update(readFileSync(zip)).digest("hex");
writeFileSync(`${zip}.sha256`, `${hash}  malves-windows.zip\n`);
console.log(`malves-windows.zip ${(statSync(zip).size / 1e6).toFixed(0)} MB, sha256 ${hash}`);
