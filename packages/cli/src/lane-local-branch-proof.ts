import * as z from "zod";
import { spawnSync } from "node:child_process";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { boardErrorFromValue } from "./work-native";

export const LocalBranchArtifactSchema = z.strictObject({
	branch: z
		.string()
		.min(1)
		.max(200)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
		.refine((name) => !name.includes("..") && !name.endsWith(".lock")),
	baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
});
export type LocalBranchArtifact = z.infer<typeof LocalBranchArtifactSchema>;
export interface LocalBranchProof extends LocalBranchArtifact {
	commitSha: string;
	commitShas: string[];
	evidenceId: string;
	evidenceUri: string;
}
export class LaneLocalBranchProofReadError extends Error {}

const MAX_BRANCH_COMMITS = 50;

function gitOutput(repo: string, args: string[]): string {
	const result = spawnSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args[0]} failed`);
	return result.stdout.trim();
}

/**
 * Proof for Work whose accepted delivery is an unpushed branch. The branch
 * must sit at the declared commit in the retained, clean checkout, descend
 * from the configured base, carry this Work's custody on every new commit,
 * and have test evidence submitted under the same Attempt. A missing piece
 * returns its reason; only an unreadable evidence ledger throws.
 */
export async function localBranchProof(
	artifact: LocalBranchArtifact,
	input: {
		repo: string;
		workItemId: string;
		attemptId: string;
		commitSha: string | undefined;
		verifySession: (
			session: string,
			commitSha: string,
			committedAt: number,
		) => Promise<boolean>;
		call: (args: string[]) => Promise<unknown>;
	},
	git: (args: string[]) => string = (args) => gitOutput(input.repo, args),
): Promise<LocalBranchProof | { reason: string }> {
	const { commitSha } = input;
	if (!commitSha) return { reason: "the result declared no commitSha" };
	const read = (args: string[]) => {
		try {
			return git(args);
		} catch {
			return undefined;
		}
	};
	const ref = `refs/heads/${artifact.branch}`;
	if (read(["rev-parse", "--verify", `${ref}^{commit}`]) !== commitSha)
		return {
			reason: `branch ${artifact.branch} is not at the declared commit`,
		};
	if (
		read(["symbolic-ref", "-q", "HEAD"]) !== ref ||
		read(["rev-parse", "HEAD"]) !== commitSha
	)
		return {
			reason: `the retained checkout is not on ${artifact.branch} at the declared commit`,
		};
	if (read(["status", "--porcelain", "--untracked-files=all"]) !== "")
		return { reason: "the retained checkout is not clean" };
	if (
		artifact.baseCommit === commitSha ||
		read(["merge-base", "--is-ancestor", artifact.baseCommit, commitSha]) ===
			undefined
	)
		return {
			reason: "the declared commit does not descend from the configured base",
		};
	const commits = (
		read([
			"rev-list",
			`--max-count=${MAX_BRANCH_COMMITS + 1}`,
			`${artifact.baseCommit}..${commitSha}`,
		]) ?? ""
	)
		.split("\n")
		.filter(Boolean);
	if (!commits.length || commits.length > MAX_BRANCH_COMMITS)
		return {
			reason: `the branch must add 1 to ${MAX_BRANCH_COMMITS} commits to its base`,
		};
	for (const sha of commits) {
		const [committed, ...trailers] = (
			read(["show", "-s", "--format=%cI%n%(trailers:only,unfold)", sha]) ?? ""
		).split("\n");
		const work = trailers.filter((line) => /^Work-Item:/i.test(line));
		const sessions = trailers.filter((line) => /^Agent-Session:/i.test(line));
		const session = sessions[0]?.slice("Agent-Session:".length).trim();
		if (
			work.length !== 1 ||
			work[0] !== `Work-Item: ${input.workItemId}` ||
			sessions.length !== 1 ||
			!session ||
			!(await input.verifySession(session, sha, Date.parse(committed!)))
		)
			return {
				reason: `commit ${sha.slice(0, 12)} lacks this Work's admitted custody`,
			};
	}
	let ledger: unknown;
	try {
		ledger = await input.call([
			"work",
			"evidence",
			input.workItemId,
			"--limit",
			"100",
		]);
		const error = boardErrorFromValue(ledger);
		if (error) throw new Error(error.message);
	} catch (error) {
		throw new LaneLocalBranchProofReadError(String(error));
	}
	if (!isRecord(ledger) || !Array.isArray(ledger.data))
		throw new LaneLocalBranchProofReadError(
			"Test evidence ledger is unavailable",
		);
	const evidence = ledger.data.find(
		(row) =>
			isRecord(row) &&
			z.uuid().safeParse(row.id).success &&
			row.kind === "test_report" &&
			row.attemptId === input.attemptId &&
			typeof row.uri === "string" &&
			row.uri !== "" &&
			row.disposition !== "rejected" &&
			row.disposition !== "superseded",
	);
	if (!evidence) {
		if (ledger.nextCursor !== null)
			throw new LaneLocalBranchProofReadError(
				"Complete test evidence ledger is unavailable",
			);
		return { reason: "no test_report evidence was submitted by this Attempt" };
	}
	return {
		...artifact,
		commitSha,
		commitShas: commits,
		evidenceId: evidence.id,
		evidenceUri: evidence.uri,
	};
}
