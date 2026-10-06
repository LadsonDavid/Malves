import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Nightly backup of Malves' memory (the Obsidian vault) to your own server.
 * The vault is packed, gzipped and encrypted on the laptop with AES-256-GCM
 * and a key that never leaves it (`backup.key` in the malves data folder), then
 * streamed over SSH (Tailscale) into ~/malves-backups. The 14 newest are kept.
 *
 *   MALVES_BACKUP_SSH       e.g. ubuntu@100.69.0.115 (needs key-based SSH login)
 *   MALVES_BACKUP_SSH_KEY   optional: the private key file to log in with
 */
const MAGIC = Buffer.from("MLVB1");
const KEEP = 14;
const DAY_MS = 24 * 60 * 60_000;

/** The vault's files (Markdown and Obsidian settings), encrypted into one blob. */
export function packVault(vault: string, key: Buffer): Buffer {
  const files: Array<{ path: string; data: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".trash") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files.push({
          path: path.relative(vault, full).split(path.sep).join("/"),
          data: readFileSync(full).toString("base64"),
        });
      }
    }
  };
  walk(vault);
  const plain = gzipSync(JSON.stringify({ v: 1, at: new Date().toISOString(), files }));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Opens a backup; throws if the key is wrong or the file was changed. */
export function unpackVault(blob: Buffer, key: Buffer): Array<{ path: string; data: Buffer }> {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a malves backup.");
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]);
  } catch {
    throw new Error("Wrong backup key, or the backup was damaged.");
  }
  const json = JSON.parse(gunzipSync(plain).toString("utf8")) as {
    files: Array<{ path: string; data: string }>;
  };
  return json.files.map((f) => ({ path: f.path, data: Buffer.from(f.data, "base64") }));
}

/** Writes a backup's files into `folder`, which must be new or empty: never over the live vault. */
export function restoreVault(blob: Buffer, key: Buffer, folder: string): number {
  if (existsSync(folder) && readdirSync(folder).length > 0) {
    throw new Error(`${folder} isn't empty. Restore into a new folder, then copy what you need.`);
  }
  const files = unpackVault(blob, key);
  for (const file of files) {
    const target = path.resolve(folder, file.path);
    // A backup can't write outside the folder.
    if (!target.startsWith(path.resolve(folder) + path.sep)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
  return files.length;
}

/** The backup key, made on first use. Lose it and the backups can't be opened. */
export function backupKey(dataDir: string): Buffer {
  const file = path.join(dataDir, "backup.key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

export type BackupOptions = { vault: string; dataDir: string; target: string; sshKey?: string };

/** Encrypts the vault and streams it to the server over SSH. Returns the file name there. */
export function backupNow(o: BackupOptions): Promise<string> {
  const blob = packVault(o.vault, backupKey(o.dataDir));
  const name = `vault-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`;
  // Fixed command, only our own file name in it; old backups beyond KEEP are removed.
  const remote = `mkdir -p ~/malves-backups && cat > ~/malves-backups/${name} && ls -1t ~/malves-backups/vault-*.bin | tail -n +${KEEP + 1} | xargs -r rm -f`;
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=20",
    ...(o.sshKey ? ["-i", o.sshKey] : []),
    o.target,
    remote,
  ];
  return new Promise((resolve, reject) => {
    // ssh is a real program (Windows ships OpenSSH), not a .cmd shim.
    const child = spawn("ssh", args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => reject(new Error(`Couldn't run ssh: ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) {
        writeFileSync(
          path.join(o.dataDir, "backup-last.json"),
          JSON.stringify({ at: Date.now(), name, bytes: blob.length }),
        );
        resolve(name);
      } else
        reject(new Error(`Backup upload failed (ssh ${code}): ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.end(blob);
  });
}

/** Backs up about once a day while serve runs (first check five minutes after start). */
export function startBackups(o: BackupOptions, say: (line: string) => void): () => void {
  const due = () => {
    try {
      const last = JSON.parse(readFileSync(path.join(o.dataDir, "backup-last.json"), "utf8")) as {
        at: number;
      };
      return Date.now() - last.at >= DAY_MS;
    } catch {
      return true;
    }
  };
  const tick = () => {
    if (!existsSync(o.vault) || !statSync(o.vault).isDirectory() || !due()) return;
    backupNow(o).then(
      (name) => say(`Malves' memory backed up to ${o.target}: ${name}`),
      (error: Error) => say(`Malves' memory backup didn't work: ${error.message}`),
    );
  };
  const first = setTimeout(tick, 5 * 60_000);
  const hourly = setInterval(tick, 60 * 60_000);
  first.unref();
  hourly.unref();
  return () => {
    clearTimeout(first);
    clearInterval(hourly);
  };
}
