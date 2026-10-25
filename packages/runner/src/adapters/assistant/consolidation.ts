import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JournalEntry = {
  timestamp: number;
  taskPrompt?: string | undefined;
  command?: string | undefined;
  outcome?: "success" | "failure" | undefined;
  summary?: string | undefined;
};

export type ConsolidationOptions = {
  vaultDir: string;
  projectId: string;
  entries: JournalEntry[];
  date?: string | undefined; // YYYY-MM-DD
};

export type ConsolidationResult = {
  projectNotesPath: string;
  backupPath: string;
  previousContent: string;
  updatedContent: string;
  commandsAdded: number;
  pitfallsAdded: number;
};

/**
 * Stage 9: Project Notes & Nightly Memory Consolidation (§9).
 * Merges the day's journal into project notes in the vault (OpenClaw `dreaming.md`),
 * keeping the previous text in `notes.prev.md` so any bad merge can be undone.
 */
export function consolidateDailyJournal(options: ConsolidationOptions): ConsolidationResult {
  const { vaultDir, projectId, entries } = options;
  const projectDir = path.join(vaultDir, "projects", projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const projectNotesPath = path.join(projectDir, "notes.md");
  const backupPath = path.join(projectDir, "notes.prev.md");

  const previousContent = existsSync(projectNotesPath)
    ? readFileSync(projectNotesPath, "utf8")
    : `# Project Notes: ${projectId}\n\n`;

  // Preserve previous content for zero-risk rollback
  writeFileSync(backupPath, previousContent, "utf8");

  const today = options.date ?? new Date().toISOString().slice(0, 10);
  const verifiedCommands: string[] = [];
  const pitfalls: string[] = [];

  for (const entry of entries) {
    if (entry.command) {
      if (entry.outcome === "success") {
        verifiedCommands.push(entry.command);
      } else if (entry.outcome === "failure" && entry.summary) {
        pitfalls.push(`${entry.command}: ${entry.summary}`);
      }
    }
  }

  let addition = `\n### Consolidated ${today}\n`;
  if (verifiedCommands.length > 0) {
    addition += `\n**Verified Commands:**\n${verifiedCommands.map((c) => `- \`${c}\``).join("\n")}\n`;
  }
  if (pitfalls.length > 0) {
    addition += `\n**Pitfalls & Errors:**\n${pitfalls.map((p) => `- ${p}`).join("\n")}\n`;
  }

  const updatedContent = previousContent.trimEnd() + "\n" + addition;
  writeFileSync(projectNotesPath, updatedContent, "utf8");

  return {
    projectNotesPath,
    backupPath,
    previousContent,
    updatedContent,
    commandsAdded: verifiedCommands.length,
    pitfallsAdded: pitfalls.length,
  };
}

/**
 * Undoes the most recent consolidation by restoring `notes.prev.md`.
 */
export function undoConsolidation(vaultDir: string, projectId: string): boolean {
  const projectDir = path.join(vaultDir, "projects", projectId);
  const projectNotesPath = path.join(projectDir, "notes.md");
  const backupPath = path.join(projectDir, "notes.prev.md");

  if (!existsSync(backupPath)) return false;
  const backup = readFileSync(backupPath, "utf8");
  writeFileSync(projectNotesPath, backup, "utf8");
  return true;
}

/**
 * Loads project notes for the planner and verifier steps (§9).
 */
export function loadProjectNotes(vaultDir: string, projectId: string): string | undefined {
  const projectNotesPath = path.join(vaultDir, "projects", projectId, "notes.md");
  if (!existsSync(projectNotesPath)) return undefined;
  return readFileSync(projectNotesPath, "utf8");
}
