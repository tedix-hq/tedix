import { describe, expect, test } from "bun:test";
import { renderLocalRepoContext } from "./local-context";

describe("@tedix/cli local context", () => {
	test("renders non-git cwd honestly", () => {
		expect(renderLocalRepoContext({ cwd: "/tmp/example" })).toBe(
			[
				"Local terminal context:",
				"- cwd: /tmp/example",
				"- git: not inside a git worktree",
			].join("\n"),
		);
	});

	test("renders git status as an indented block", () => {
		expect(
			renderLocalRepoContext({
				cwd: "/repo/subdir",
				gitRoot: "/repo",
				origin: "https://github.com/tedix-hq/tedix",
				head: "abc1234",
				status: "## main...origin/main\n M package.json",
			}),
		).toBe(
			[
				"Local terminal context:",
				"- cwd: /repo/subdir",
				"- gitRoot: /repo",
				"- origin: https://github.com/tedix-hq/tedix",
				"- head: abc1234",
				"- gitStatus:",
				"  ## main...origin/main",
				"   M package.json",
			].join("\n"),
		);
	});
});
