import { afterEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LaneLocalBranchProofReadError,
	LocalBranchArtifactSchema,
	localBranchProof,
} from "./lane-local-branch-proof";

const workItemId = "22222222-2222-4222-8222-222222222222";
const attemptId = "fictional-attempt";
const session = "codex:fictional-session";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const branch = "prepare/fictional-gap3";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function checkout() {
	const repo = mkdtempSync(join(tmpdir(), "lane-local-branch-"));
	dirs.push(repo);
	const git = (...args: string[]) => {
		const result = spawnSync(
			"git",
			[
				"-C",
				repo,
				"-c",
				"user.name=Fictional",
				"-c",
				"user.email=fictional@example.com",
				"-c",
				"commit.gpgsign=false",
				...args,
			],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	const commit = (file: string, message: string) => {
		writeFileSync(join(repo, file), message);
		git("add", file);
		git("commit", "-m", message);
		return git("rev-parse", "HEAD");
	};
	git("init", "-b", "main");
	const base = commit("base.txt", "base");
	git("checkout", "-b", branch);
	return { repo, git, commit, base };
}
const trailers = `\n\nWork-Item: ${workItemId}\nAgent-Session: ${session}`;

it.each([
	"proven",
	"twoCommits",
	"undeclared",
	"otherCommit",
	"otherBranch",
	"detached",
	"dirty",
	"untracked",
	"unrelatedBase",
	"baseIsTip",
	"noTrailers",
	"otherWork",
	"foreignCommit",
	"custodyRefused",
	"noEvidence",
	"otherAttempt",
	"otherKind",
	"rejectedEvidence",
	"ledgerTruncated",
	"ledgerUnavailable",
])("checks local branch delivery: %s", async (scenario) => {
	const { repo, git, commit, base } = checkout();
	if (scenario === "foreignCommit") commit("foreign.txt", "unattributed");
	if (scenario === "twoCommits") commit("first.txt", `first${trailers}`);
	const tip = commit(
		"change.txt",
		scenario === "noTrailers"
			? "change"
			: scenario === "otherWork"
				? `change\n\nWork-Item: 33333333-3333-4333-8333-333333333333\nAgent-Session: ${session}`
				: `change${trailers}`,
	);
	let declared: string | undefined = tip;
	let baseCommit = base;
	if (scenario === "undeclared") declared = undefined;
	if (scenario === "otherCommit") declared = base;
	if (scenario === "otherBranch") {
		git("checkout", "-b", "prepare/other");
		git("branch", "-D", branch);
	}
	if (scenario === "detached") git("checkout", "--detach");
	if (scenario === "dirty") writeFileSync(join(repo, "change.txt"), "edited");
	if (scenario === "untracked") writeFileSync(join(repo, "scratch.txt"), "x");
	if (scenario === "unrelatedBase") baseCommit = "d".repeat(40);
	if (scenario === "baseIsTip") baseCommit = tip;
	const verified: string[] = [];
	const result = localBranchProof(
		{ branch, baseCommit },
		{
			repo,
			workItemId,
			attemptId,
			commitSha: declared,
			verifySession: async (commitSession, sha, committedAt) => {
				expect(commitSession).toBe(session);
				expect(Number.isFinite(committedAt)).toBe(true);
				verified.push(sha);
				return scenario !== "custodyRefused";
			},
			call: async (args) => {
				expect(args).toEqual([
					"work",
					"evidence",
					workItemId,
					"--limit",
					"100",
				]);
				if (scenario === "ledgerUnavailable")
					throw new Error("gateway unavailable");
				return {
					data:
						scenario === "noEvidence" || scenario === "ledgerTruncated"
							? []
							: [
									{
										id: evidenceId,
										attemptId:
											scenario === "otherAttempt" ? "other-attempt" : attemptId,
										kind: scenario === "otherKind" ? "document" : "test_report",
										uri: "artifact://fictional-test-report",
										disposition:
											scenario === "rejectedEvidence" ? "rejected" : "pending",
									},
								],
					nextCursor: scenario === "ledgerTruncated" ? "next-page" : null,
				};
			},
		},
	);
	if (scenario === "ledgerTruncated" || scenario === "ledgerUnavailable") {
		await expect(result).rejects.toBeInstanceOf(LaneLocalBranchProofReadError);
		return;
	}
	const proof = await result;
	if (scenario === "proven" || scenario === "twoCommits") {
		expect(proof).toEqual({
			branch,
			baseCommit: base,
			commitSha: tip,
			commitShas: verified,
			evidenceId,
			evidenceUri: "artifact://fictional-test-report",
		});
		expect(verified).toHaveLength(scenario === "twoCommits" ? 2 : 1);
		expect(verified[0]).toBe(tip);
	} else {
		expect(proof).toEqual({ reason: expect.any(String) });
	}
});

it.each(["../main", "a..b", "-x", "x.lock", "a b", "a//b", ""])(
	"refuses branch name %p",
	(name) => {
		expect(
			LocalBranchArtifactSchema.safeParse({
				branch: name,
				baseCommit: "a".repeat(40),
			}).success,
		).toBe(false);
	},
);
