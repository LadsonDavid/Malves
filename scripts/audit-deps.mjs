// Fails on a high or critical advisory in what malves ships or runs, ignoring
// only the Expo build tools (they run on the build machine and are not part of
// the app or the runner). `pnpm audit` alone can't do this: it has no filter.
//
// Run: node scripts/audit-deps.mjs
import { spawnSync } from "node:child_process";

/** Paths through these packages are build-time only. Add to this list only with a reason. */
const BUILD_ONLY = ["packages__app>expo>@expo/cli>", "packages__app>expo>@expo/metro-config>"];

/**
 * @param {{ advisories?: Record<string, { severity: string; module_name: string; findings: Array<{ paths: string[] }> }> }} report
 * @returns {string[]} one line per advisory that still counts
 */
export function shippedProblems(report) {
  const lines = [];
  for (const a of Object.values(report.advisories ?? {})) {
    if (a.severity !== "high" && a.severity !== "critical") continue;
    const paths = a.findings.flatMap((f) => f.paths);
    const counts = paths.filter((p) => !BUILD_ONLY.some((prefix) => p.startsWith(prefix)));
    if (counts.length > 0) lines.push(`${a.severity} ${a.module_name}: ${counts[0]}`);
  }
  return lines;
}

const isMain = process.argv[1]?.endsWith("audit-deps.mjs");
if (isMain) {
  // One fixed command string (no arguments to escape); on Windows pnpm is a .cmd shim, so it needs the shell.
  const run = spawnSync("pnpm audit --prod --json", {
    encoding: "utf8",
    shell: true,
    maxBuffer: 50_000_000,
  });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    console.error(`pnpm audit gave no readable answer:\n${run.stdout}${run.stderr}`);
    process.exit(1);
  }
  const problems = shippedProblems(report);
  if (problems.length > 0) {
    console.error(
      `High or critical advisories in what malves ships:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log("No high or critical advisories in what malves ships or runs.");
}
