// Checks features.json: the list of everything malves does, and how far each one
// has been proven. Run by CI (`node scripts/check-features.mjs`) and by a test.
//
// An idea from Agent Relay's feature manifest, cut down to what a solo project needs:
// the point is that "awaiting a real test" stops being a sentence in a README and
// becomes a list that CI keeps honest.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATUSES = ["verified-real", "automated-only", "awaiting-real-test", "known-issue"];
export const CRITICALITY = ["critical", "hot", "standard"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {unknown} manifest the parsed features.json
 * @param {string} base the repository folder that evidence paths are relative to
 * @returns {{ errors: string[], summary: Record<string, number>, todo: string[] }}
 */
export function checkFeatures(manifest, base = root) {
  const errors = [];
  const summary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const todo = [];
  const features = manifest && Array.isArray(manifest.features) ? manifest.features : undefined;
  if (!features || features.length === 0)
    return { errors: ["features.json needs a `features` list."], summary, todo };

  const seen = new Set();
  for (const [i, f] of features.entries()) {
    const at = `feature ${f?.id ?? `#${i + 1}`}`;
    if (typeof f?.id !== "string" || !/^[a-z0-9-]+$/.test(f.id))
      errors.push(`${at}: id must be lowercase words joined by dashes.`);
    else if (seen.has(f.id)) errors.push(`${at}: the id is used twice.`);
    else seen.add(f.id);
    if (typeof f?.name !== "string" || f.name.length < 3) errors.push(`${at}: needs a name.`);
    if (typeof f?.area !== "string" || f.area.length < 2) errors.push(`${at}: needs an area.`);
    if (!CRITICALITY.includes(f?.criticality))
      errors.push(`${at}: criticality must be one of ${CRITICALITY.join(", ")}.`);
    if (!STATUSES.includes(f?.status)) {
      errors.push(`${at}: status must be one of ${STATUSES.join(", ")}.`);
      continue;
    }
    summary[f.status] += 1;

    const evidence = Array.isArray(f.evidence) ? f.evidence : [];
    if (f.status !== "known-issue" && evidence.length === 0)
      errors.push(`${at}: needs evidence (a test file or a note file).`);
    for (const file of evidence) {
      if (typeof file !== "string" || !existsSync(path.join(base, file)))
        errors.push(`${at}: evidence file not found: ${file}`);
    }
    // Anything not proven on a real device must say how the owner proves it.
    if (
      f.status !== "verified-real" &&
      !(typeof f.real_test === "string" && f.real_test.length >= 15)
    ) {
      errors.push(
        `${at}: say how to check it on a real device (real_test, at least 15 characters).`,
      );
    }
    if (f.status === "known-issue" && !(typeof f.notes === "string" && f.notes.length >= 10)) {
      errors.push(`${at}: a known issue needs notes saying what is wrong.`);
    }
    if (f.criticality === "critical" && f.status === "automated-only" && evidence.length === 0) {
      errors.push(`${at}: a critical feature needs tests.`);
    }
    if (f.status === "awaiting-real-test" || f.status === "known-issue")
      todo.push(`${f.id}: ${f.real_test ?? f.notes}`);
  }
  return { errors, summary, todo };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const manifest = JSON.parse(readFileSync(path.join(root, "features.json"), "utf8"));
  const { errors, summary, todo } = checkFeatures(manifest);
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  console.log(`${total} features:`);
  for (const [status, n] of Object.entries(summary))
    console.log(`  ${String(n).padStart(3)}  ${status}`);
  if (todo.length > 0)
    console.log(
      `\nStill to prove on a real device or fix:\n${todo.map((t) => `  - ${t}`).join("\n")}`,
    );
  if (errors.length > 0) {
    console.error(
      `\n${errors.length} problem(s) in features.json:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
    process.exit(1);
  }
}
