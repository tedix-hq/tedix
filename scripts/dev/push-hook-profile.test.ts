import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test.each([
	[undefined, false],
	["fast", true],
	["full", false],
	["unknown", false],
] as const)("hook profile %s selects fast checks: %s", (profile, fast) => {
	const root = mkdtempSync(join(tmpdir(), "push-hook-profile-"));
	roots.push(root);
	const args = join(root, "args");
	const bun = join(root, "bun");
	writeFileSync(bun, '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOOK_ARGS"\n');
	chmodSync(bun, 0o755);
	const env: NodeJS.ProcessEnv = {
		...detachedGitEnv(),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_COUNT: "0",
		HOOK_ARGS: args,
		PATH: root + delimiter + process.env.PATH,
	};
	delete env.GIT_CONFIG_PARAMETERS;
	const init = spawnSync("git", ["init", root], { env });
	expect(init.status).toBe(0);
	if (profile) {
		const configured = spawnSync(
			"git",
			["-C", root, "config", "tedix.pushGateProfile", profile],
			{ env },
		);
		expect(configured.status).toBe(0);
	}
	const result = spawnSync(
		"bash",
		[
			new URL("../../.githooks/pre-push", import.meta.url).pathname,
			"origin",
			"https://github.com/example/product.git",
		],
		{
			cwd: root,
			env,
			encoding: "utf8",
			input: `refs/heads/main ${"a".repeat(40)} refs/heads/main ${"b".repeat(40)}\n`,
		},
	);
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(readFileSync(args, "utf8").split("\n").includes("--local-fast")).toBe(
		fast,
	);
});
