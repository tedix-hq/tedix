import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** A stale remote ref may retain extra commits, but must never lose one. */
export async function unpushedLaneCommits(repo: string): Promise<string[]> {
	const { stdout } = await promisify(execFile)(
		"git",
		["-C", repo, "rev-list", "HEAD", "--not", "refs/remotes/origin/main"],
		{ encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout.trim() ? stdout.trim().split("\n") : [];
}
