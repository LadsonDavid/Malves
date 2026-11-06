import fs from "node:fs";
import path from "node:path";
import type { JobVerifier } from "@malves/core";
import { runCommand } from "../assistant/handover.js";

/**
 * Runs the project's test suite to verify integration and quality.
 * Detects test runners based on files present in the root folder.
 */
export class ProjectVerifier implements JobVerifier {
  constructor(private readonly timeoutMs = 120_000) {}

  async verify(root: string): Promise<{ passed: boolean; output: string }> {
    const command = this.detectTestCommand(root);
    if (!command) {
      return { passed: true, output: "No automated test suite detected." };
    }

    const output = await runCommand(command, root, this.timeoutMs);
    const passed = !output.includes("Exit code") || output.includes("Exit code 0");
    return { passed, output };
  }

  private detectTestCommand(root: string): string | undefined {
    if (fs.existsSync(path.join(root, "package.json"))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        if (pkg.scripts?.test) {
          if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm test";
          if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn test";
          return "npm test";
        }
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(path.join(root, "Cargo.toml"))) return "cargo test";
    if (
      fs.existsSync(path.join(root, "pyproject.toml")) ||
      fs.existsSync(path.join(root, "pytest.ini"))
    ) {
      return "pytest";
    }
    return undefined;
  }
}
