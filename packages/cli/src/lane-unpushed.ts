import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { detachedGitEnv } from "../../../scripts/oss/git-env";

/** A stale remote ref may retain extra commits, but must never lose one. */
export async function unpushedLaneCommits(repo: string): Promise<string[]> {
	// Git otherwise searches parent folders and can report their entire history.
	if (!existsSync(join(repo, ".git"))) return [];
	const { stdout } = await promisify(execFile)(
		"git",
		["-C", repo, "rev-list", "HEAD", "--not", "refs/remotes/origin/main"],
		{
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 16 * 1024 * 1024,
			env: detachedGitEnv(),
		},
	);
	return stdout.trim() ? stdout.trim().split("\n") : [];
}
