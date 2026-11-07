import * as z from "zod";
import { execFileSync } from "node:child_process";
import { GetWorkInteractionResultSchema } from "@tedix/api-contract/schemas/work-interactions";

const fence = {
	workItemId: z.uuid(),
	workVersion: z.number().int().positive(),
	contractVersion: z.number().int().positive(),
	outcomeText: z.string().min(1).max(2000),
};
// Declarations are retained in laneResult metadata; landed commits are verified separately.
const proof = {
	commitSha: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.optional(),
	evidenceRefs: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
};
export const LaneResultSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		...fence,
		...proof,
		outcome: z.literal("completed"),
	}),
	z.strictObject({
		...fence,
		...proof,
		outcome: z.literal("incomplete"),
		remaining: z.string().min(1).max(1800),
	}),
	z.strictObject({
		...fence,
		outcome: z.literal("waiting_on_user"),
		interactionId: z.uuid(),
		requestVersion: z.number().int().positive(),
		orgId: z.uuid(),
		userId: z.string().min(1).max(300),
	}),
	z.strictObject({
		...fence,
		outcome: z.literal("deferred"),
		reason: z.string().min(1).max(1800),
		until: z.iso.datetime().optional(),
	}),
	z.strictObject({
		...fence,
		outcome: z.literal("already_satisfied"),
		commitSha: z.string().regex(/^[a-f0-9]{40}$/),
		runId: z.number().int().positive(),
		workflowName: z.string().min(1).max(300),
		minimumCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
		rootCause: z.string().min(10).max(1000),
	}),
]);
export type LaneResult = z.infer<typeof LaneResultSchema>;
export type LaneWait = Extract<LaneResult, { outcome: "waiting_on_user" }>;
export type LaneDeferral = Extract<LaneResult, { outcome: "deferred" }>;
export type ExistingLaneResult = Extract<
	LaneResult,
	{ outcome: "already_satisfied" }
>;

export function parseLaneResult(message: string): LaneResult | undefined {
	const lines = message
		.split("\n")
		.filter((line) => line.startsWith("TEDIX_LANE_RESULT"));
	if (!lines.length) return;
	if (
		lines.length !== 1 ||
		lines[0]!.length > 6000 ||
		!lines[0]!.startsWith("TEDIX_LANE_RESULT ")
	)
		throw new Error("Expected one bounded TEDIX_LANE_RESULT JSON line");
	return LaneResultSchema.parse(
		JSON.parse(lines[0]!.slice("TEDIX_LANE_RESULT ".length)),
	);
}

/** A closed card, a missing inbox row, or an agent's reply is not human consent. */
export function laneWaitResponse(
	wait: LaneWait,
	value: unknown,
): string | undefined {
	const parsed = GetWorkInteractionResultSchema.safeParse(value);
	if (!parsed.success) return;
	const { request, responses, effectiveState } = parsed.data;
	if (
		request.id !== wait.interactionId ||
		request.orgId !== wait.orgId ||
		request.workItemId !== wait.workItemId ||
		request.requestedFromType !== "user" ||
		request.requestedFromId !== wait.userId ||
		request.version <= wait.requestVersion ||
		request.state !== "resolved" ||
		effectiveState !== "resolved" ||
		responses.hasMore ||
		responses.nextCursor !== null
	)
		return;
	return responses.data.find(
		(response) =>
			response.requestId === request.id &&
			response.resolvesRequest &&
			response.respondedByType === "user" &&
			response.respondedById === wait.userId &&
			["handoff_accepted", "answer", "input_provided"].includes(
				response.responseKind,
			),
	)?.id;
}

export class LaneOutcomeReadError extends Error {}

const ciRunSchema = z.object({
	id: z.number().int().positive(),
	workflow_id: z.number().int().positive(),
	run_attempt: z.number().int().positive(),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	head_branch: z.string(),
	head_sha: z.string().regex(/^[a-f0-9]{40}$/),
});

const command = (repo: string, executable: string, args: string[]) =>
	execFileSync(executable, args, {
		cwd: repo,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	}).trim();

/** Only the explicit CI recovery mode can cite preexisting repository history. */
export function verifyExistingLaneResult(
	repo: string,
	result: ExistingLaneResult,
	run = (executable: string, args: string[]) => command(repo, executable, args),
) {
	if (
		!result.outcomeText
			.toLowerCase()
			.includes(result.workflowName.toLowerCase()) ||
		!new RegExp(`\\b${result.minimumCommit}\\b`).test(result.outcomeText)
	)
		throw new Error(
			"Existing CI proof does not name the accepted workflow and minimum commit",
		);
	const remote = run("git", ["remote", "get-url", "origin"]);
	const repository =
		/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
			remote,
		)?.[1];
	if (!repository)
		throw new Error("Existing CI proof requires the checkout's GitHub origin");
	let proof: z.infer<typeof ciRunSchema>;
	let latest: z.infer<typeof ciRunSchema>;
	try {
		run("git", [
			"fetch",
			"--no-tags",
			"origin",
			"refs/heads/main:refs/remotes/origin/main",
		]);
		proof = ciRunSchema.parse(
			JSON.parse(
				run("gh", ["api", `repos/${repository}/actions/runs/${result.runId}`]),
			),
		);
		latest = z
			.object({ workflow_runs: z.array(ciRunSchema).length(1) })
			.parse(
				JSON.parse(
					run("gh", [
						"api",
						`repos/${repository}/actions/workflows/${proof.workflow_id}/runs?branch=main&per_page=1`,
					]),
				),
			).workflow_runs[0]!;
	} catch (error) {
		throw new LaneOutcomeReadError(String(error));
	}
	const sha = proof.head_sha;
	if (
		proof.id !== result.runId ||
		proof.name !== result.workflowName ||
		proof.status !== "completed" ||
		proof.conclusion !== "success" ||
		proof.head_branch !== "main" ||
		latest.id !== result.runId ||
		latest.run_attempt !== proof.run_attempt ||
		latest.status !== "completed" ||
		latest.conclusion !== "success" ||
		latest.head_sha !== sha
	)
		throw new Error(
			"Existing CI outcome is not the latest successful main workflow run",
		);
	for (const [ancestor, descendant] of [
		[result.commitSha, sha],
		[result.minimumCommit, sha],
		[sha, "refs/remotes/origin/main"],
	]) {
		try {
			run("git", ["merge-base", "--is-ancestor", ancestor!, descendant!]);
		} catch {
			throw new Error(
				"Existing CI commits do not satisfy the accepted ancestry",
			);
		}
	}
	return {
		mode: "verified_existing" as const,
		commitSha: result.commitSha,
		runId: result.runId,
		runAttempt: proof.run_attempt,
		runCommitSha: sha,
		evidenceUri: `https://github.com/${repository}/actions/runs/${result.runId}`,
		rootCause: result.rootCause,
	};
}
