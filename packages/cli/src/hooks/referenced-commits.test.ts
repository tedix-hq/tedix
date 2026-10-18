import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referencedCommitEvidence } from "./referenced-commits";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("reads only cited commits available at the event time and labels file evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "ledger-commits-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Fixture",
				GIT_AUTHOR_EMAIL: "user@example.com",
				GIT_COMMITTER_NAME: "Fixture",
				GIT_COMMITTER_EMAIL: "user@example.com",
				GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
			},
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	git("init");
	writeFileSync(join(root, "demo.test.ts"), "fixture");
	git("add", ".");
	git(
		"commit",
		"-m",
		"Fix <scope>",
		"-m",
		"Validation: targeted tests passed.\nPrivate unrelated body.",
	);
	const sha = git("rev-parse", "HEAD");
	const blob = git("rev-parse", "HEAD:demo.test.ts");
	const text = `Fixed (${sha.slice(0, 8)}). commit ${sha}\n\`${blob}\` \`deadbeef\``;
	const result = referencedCommitEvidence(root, text, "2020-01-02T00:00:00Z");
	expect(result).toContain(`Commit ${sha}`);
	expect(result).toContain("not verified on origin/main");
	git("update-ref", "refs/remotes/origin/main", sha);
	expect(
		referencedCommitEvidence(root, text, "2020-01-02T00:00:00Z"),
	).toContain("reachable from local origin/main");
	expect(result.match(/Commit /g)).toHaveLength(1);
	expect(result).toContain("Fix &lt;scope&gt;");
	expect(result).toContain("Validation: targeted tests passed.");
	expect(result).toContain("Changed test file: demo.test.ts");
	expect(result).not.toContain("Private unrelated body");
	expect(result).not.toContain(blob);
	expect(referencedCommitEvidence(root, text, "2019-01-01T00:00:00Z")).toBe("");
	expect(
		referencedCommitEvidence(root, "No cited commit", "2020-01-02T00:00:00Z"),
	).toBe("");
});

test("skips unknown roots and unavailable repositories", () => {
	expect(
		referencedCommitEvidence(
			undefined,
			"commit deadbeef",
			new Date().toISOString(),
		),
	).toBe("");
	expect(
		referencedCommitEvidence(
			"relative",
			"commit deadbeef",
			new Date().toISOString(),
		),
	).toBe("");
	const root = mkdtempSync(join(tmpdir(), "ledger-no-git-"));
	roots.push(root);
	expect(
		referencedCommitEvidence(root, "commit deadbeef", new Date().toISOString()),
	).toBe("");
});
