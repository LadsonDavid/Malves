import { execFile } from "node:child_process";

/**
 * Finds this machine's Tailscale IPv4 address with `tailscale ip -4`, so the
 * link can bind to the tailnet only. Returns undefined if Tailscale isn't
 * installed or isn't up.
 */
export function tailscaleAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("tailscale", ["ip", "-4"], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      const ip = stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(line));
      resolve(ip);
    });
  });
}
