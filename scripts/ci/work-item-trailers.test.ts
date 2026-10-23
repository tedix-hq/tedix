import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	missingWorkItemTrailers,
	workItemTrailerError,
} from "./work-item-trailers.mjs";

const root = mkdtempSync(join(tmpdir(), "work-item-trailers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = (message: string, email = "fixture@example.test") => {
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		`user.email=${email}`,
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		message,
	);
	return git("rev-parse", "HEAD");
};
const id = "0f1e2d3c-4b5a-4968-8776-655443322110";

git("init", "-q", "-b", "main");
const base = commit("base");
const linked = commit(`fix: linked\n\nWork-Item: ${id}`);
const unlinked = commit("fix: no work item\n\nAgent-Session: codex:fixture");
commit("chore: bump", "41898282+github-actions[bot]@users.noreply.github.com");
const malformed = commit("fix: short id\n\nWork-Item: 0f1e2d3c");
const head = git("rev-parse", "HEAD");

test("names every pushed commit without a full Work-Item trailer", () => {
	const missing = missingWorkItemTrailers(root, [{ base, head }]);
	expect(missing.map(({ sha }) => sha)).toEqual([malformed, unlinked]);
	expect(missing.some(({ sha }) => sha === linked)).toBe(false);
	expect(workItemTrailerError(missing)).toContain(
		`${unlinked.slice(0, 9)} fix: no work item`,
	);
});

test("a range whose commits all carry the trailer passes", () => {
	expect(missingWorkItemTrailers(root, [{ base, head: linked }])).toEqual([]);
});
