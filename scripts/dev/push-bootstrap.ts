import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

/** Pin the queue and its imports to one fetched main snapshot, keeping the lane's cwd. */
export function runCurrentQueue(): number {
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr || "git failed");
		return result.stdout.trim();
	};
	git("fetch", "--quiet", "origin", "main");
	const main = git("rev-parse", "origin/main");
	const candidate = process.argv.includes("--queue-candidate");
	const sha = candidate ? git("rev-parse", "HEAD") : main;
	if (candidate) {
		const ancestry = spawnSync("git", [
			"merge-base",
			"--is-ancestor",
			main,
			sha,
		]);
		if (ancestry.status !== 0)
			throw new Error(
				"Queue candidate must contain freshly fetched origin/main; rebase first",
			);
	}
	const common = resolve(git("rev-parse", "--git-common-dir"));
	const snapshot = mkdtempSync(join(common, "push-code-"));
	try {
		const archive = spawnSync("git", ["archive", sha, "scripts"], {
			maxBuffer: 32 * 1024 * 1024,
		});
		if (archive.status !== 0)
			throw new Error("could not archive current queue");
		const unpack = spawnSync("tar", ["-xf", "-", "-C", snapshot], {
			input: archive.stdout,
		});
		if (unpack.status !== 0) throw new Error("could not unpack current queue");
		console.log(
			`push: queue logic from ${candidate ? "committed candidate" : "origin/main"} ${sha.slice(0, 12)}.`,
		);
		const result = spawnSync(
			process.execPath,
			[join(snapshot, "scripts/dev/push-queue.ts"), ...process.argv.slice(2)],
			{
				stdio: "inherit",
				env: { ...process.env, TEDIX_PUSH_QUEUE_SNAPSHOT: sha },
			},
		);
		return result.status ?? 1;
	} finally {
		rmSync(snapshot, { recursive: true, force: true });
	}
}
