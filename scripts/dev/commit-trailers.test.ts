import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import { trailerFindings } from "../oss/secret-scan";
import { joinTrailerParagraphs } from "./commit-trailers";

const WORK = "Work-Item: 5c20c5a6-c069-48d7-84cd-59a245ba7aea";
const SESSION = "Agent-Session: opencode:28e3f3d3-3b5e-4ee5-9b72-d7a51b7406d8";
const COAUTHOR = "Co-Authored-By: OpenCode <noreply@example.invalid>";

test("trailers split by blank lines join into one final paragraph", () => {
	// The exact shape of the refused lane commit 35f7edaf (Work 5c20c5a6).
	const split = `test(cli): control conversation poller timing\n\n${WORK}\n\n${SESSION}\n\n${COAUTHOR}\n`;
	expect(trailerFindings(split)).not.toEqual([]);
	const joined = joinTrailerParagraphs(split);
	expect(joined).toBe(
		`test(cli): control conversation poller timing\n\n${WORK}\n${SESSION}\n${COAUTHOR}\n`,
	);
	expect(trailerFindings(joined)).toEqual([]);

	const withBody = `fix(home): dispatch bounded work\n\nRepair mappings.\n\n${WORK}\n\n${SESSION}\nClaude-Session: https://claude.ai/code/session_01AbC\n\nCo-Authored-By: Codex <noreply@openai.com>`;
	expect(joinTrailerParagraphs(withBody)).toBe(
		`fix(home): dispatch bounded work\n\nRepair mappings.\n\n${WORK}\n${SESSION}\nClaude-Session: https://claude.ai/code/session_01AbC\nCo-Authored-By: Codex <noreply@openai.com>`,
	);
});

test("other messages are left exactly as written", () => {
	for (const message of [
		`fix: one block\n\n${WORK}\n${SESSION}\n`,
		"fix: no trailers\n\nBody text.\n",
		// A body paragraph between trailer paragraphs stays where it is.
		`fix: x\n\n${WORK}\n\nNot a trailer.\n\n${SESSION}\n`,
		// The subject is never folded into the trailers.
		`${WORK}\n\n${SESSION}\n`,
		// Unknown keys are prose, not provenance.
		`fix: x\n\nNote: this is prose\n\n${WORK}\n${SESSION}\n`,
	])
		expect(joinTrailerParagraphs(message)).toBe(message);
});

test("joining never hides what the scan refuses", () => {
	// Two Work-Item trailers (lane commit 502f36e0) and an invented session id
	// (433df419) still fail after the paragraphs are joined.
	const duplicate = `test(os): stabilize approval popover menu\n\nWork-Item: 8b2d675c-116f-4f49-983b-1e6cab4d0170\n\nWork-Item: 47b29112-6649-4417-b6f1-086fa7cbe595\n\n${SESSION}\n`;
	expect(trailerFindings(joinTrailerParagraphs(duplicate))).toEqual([4]);
	const invented = `fix(os): support keyboard slide resizing\n\n${WORK}\n\nAgent-Session: opencode:lane-opencode-n9-os-make-slide-resize-control-497a0610931a\n`;
	expect(trailerFindings(joinTrailerParagraphs(invented))).toEqual([4]);
});

test("the commit-msg hook joins trailers written with one -m each", () => {
	const root = mkdtempSync(join(tmpdir(), "commit-trailers-"));
	const env = detachedGitEnv();
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	};
	try {
		git("init", "-q");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.invalid");
		git(
			"config",
			"core.hooksPath",
			new URL("../../.githooks", import.meta.url).pathname,
		);
		writeFileSync(join(root, "a.txt"), "a\n");
		git("add", "a.txt");
		// The hook resolves the script from the repository it runs in.
		const scripts = join(root, "scripts/dev");
		spawnSync("mkdir", ["-p", scripts]);
		spawnSync("cp", [
			new URL("./commit-trailers.ts", import.meta.url).pathname,
			scripts,
		]);
		git(
			"commit",
			"-q",
			"-m",
			"test: fixture",
			"-m",
			WORK,
			"-m",
			SESSION,
			"-m",
			COAUTHOR,
		);
		const message = git("log", "-1", "--format=%B");
		expect(message.trimEnd()).toBe(
			`test: fixture\n\n${WORK}\n${SESSION}\n${COAUTHOR}`,
		);
		expect(trailerFindings(message)).toEqual([]);
		expect(
			git("log", "-1", "--format=%(trailers:key=Work-Item,valueonly)").trim(),
		).toBe("5c20c5a6-c069-48d7-84cd-59a245ba7aea");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
