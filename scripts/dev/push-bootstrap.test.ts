import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";

test("an old lane executes the fetched main queue with its own cwd and arguments", () => {
	const root = mkdtempSync(join(tmpdir(), "push-bootstrap-"));
	const env = detachedGitEnv();
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	try {
		git("init", "--bare", join(root, "remote.git"));
		git("init", "-b", "main", join(root, "repo"));
		const repo = join(root, "repo");
		const runGit = (...args: string[]) => git("-C", repo, ...args);
		runGit("config", "user.name", "Bootstrap Test");
		runGit("config", "user.email", "bootstrap@example.test");
		mkdirSync(join(repo, "scripts/dev"), { recursive: true });
		writeFileSync(
			join(repo, "scripts/dev/push-queue.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "receipt"))}, JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2), sha: process.env.TEDIX_PUSH_QUEUE_SNAPSHOT})); process.exit(7);`,
		);
		runGit("add", ".");
		runGit("commit", "-m", "current queue");
		runGit("remote", "add", "origin", join(root, "remote.git"));
		runGit("push", "origin", "main");
		const base = runGit("rev-parse", "HEAD");
		writeFileSync(
			join(repo, "scripts/dev/push-queue.ts"),
			'throw new Error("stale queue must not run");',
		);
		const bootstrap = new URL("./push-bootstrap.ts", import.meta.url).pathname;
		const caller = join(root, "caller.ts");
		writeFileSync(
			caller,
			`import {runCurrentQueue} from ${JSON.stringify(bootstrap)}; process.exit(runCurrentQueue());`,
		);
		const result = spawnSync(process.execPath, [caller, "--dry-run"], {
			cwd: repo,
			env,
		});
		expect(result.status).toBe(7);
		const receipt = JSON.parse(readFileSync(join(root, "receipt"), "utf8"));
		expect(receipt.cwd).toBe(realpathSync(repo));
		expect(receipt.args).toEqual(["--dry-run"]);
		expect(receipt.sha).toMatch(/^[a-f0-9]{40}$/);
		runGit("restore", "scripts/dev/push-queue.ts");
		const queue = join(repo, "scripts/dev/push-queue.ts");
		writeFileSync(
			queue,
			readFileSync(queue, "utf8").replace("process.exit(7)", "process.exit(8)"),
		);
		runGit("add", ".");
		runGit("commit", "-m", "candidate queue");
		const candidate = runGit("rev-parse", "HEAD");
		const upgraded = spawnSync(
			process.execPath,
			[caller, "--priority", "--queue-candidate"],
			{ cwd: repo, env },
		);
		expect(upgraded.status).toBe(8);
		expect(JSON.parse(readFileSync(join(root, "receipt"), "utf8")).sha).toBe(
			candidate,
		);
		runGit("push", "origin", "main");
		runGit("reset", "--hard", base);
		const stale = spawnSync(process.execPath, [caller, "--queue-candidate"], {
			cwd: repo,
			env,
			encoding: "utf8",
		});
		expect(stale.status).not.toBe(0);
		expect(stale.stderr).toContain("must contain freshly fetched origin/main");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
