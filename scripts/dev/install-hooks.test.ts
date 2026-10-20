import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";

test("hook installation corrects the path and leaves an installed shared config untouched", () => {
	const root = mkdtempSync(join(tmpdir(), "install-hooks-"));
	const env = detachedGitEnv();
	const command = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
	).scripts["hooks:install"];
	const run = (program: string, args: string[]) => {
		const result = spawnSync(program, args, {
			cwd: root,
			env,
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
	};
	try {
		run("git", ["init", "-q"]);
		run("git", ["config", "core.hooksPath", "old-hooks"]);
		run("sh", ["-c", command]);
		expect(
			spawnSync("git", ["config", "--get", "core.hooksPath"], {
				cwd: root,
				env,
				encoding: "utf8",
			}).stdout.trim(),
		).toBe(".githooks");
		const config = join(root, ".git/config");
		const inode = statSync(config).ino;
		run("sh", ["-c", command]);
		expect(statSync(config).ino).toBe(inode);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
