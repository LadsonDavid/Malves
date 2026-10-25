import type { PullRequestOpener } from "@malves/core";
import { runCommand } from "../assistant/handover.js";

/**
 * Creates a pull request using the GitHub CLI (`gh`).
 */
export class GitHubPrOpener implements PullRequestOpener {
  constructor(private readonly timeoutMs = 30_000) {}

  async createPr(
    workspacePath: string,
    branch: string,
    title: string,
    body: string,
  ): Promise<{ url: string }> {
    // Push branch first
    await runCommand(`git push -u origin ${branch}`, workspacePath, this.timeoutMs);

    // Run gh pr create
    const cleanTitle = title.replace(/"/g, '\\"');
    const cleanBody = body.replace(/"/g, '\\"');
    const out = await runCommand(
      `gh pr create --head ${branch} --title "${cleanTitle}" --body "${cleanBody}"`,
      workspacePath,
      this.timeoutMs,
    );

    const match = out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
    if (match) {
      return { url: match[0] };
    }

    return { url: `https://github.com/branch/${branch}` };
  }
}
