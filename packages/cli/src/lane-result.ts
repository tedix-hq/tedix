import * as z from "zod";
import { execFileSync } from "node:child_process";
import { GetWorkInteractionResultSchema } from "@tedix/api-contract/schemas/work-interactions";
import { ListWorkApprovalInboxResultSchema } from "@tedix/api-contract/schemas/work-approvals";
import { safeParseServerResponse } from "./server-response";

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
const repositoryProof = {
	repositoryProof: z
		.strictObject({
			repository: z
				.string()
				.regex(/^[\w.-]+\/[\w.-]+$/)
				.max(300),
			commitSha: z.string().regex(/^[a-f0-9]{40}$/),
			runId: z.number().int().positive(),
			workflowName: z.string().min(1).max(300),
		})
		.optional(),
};
export const LaneResultSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		...fence,
		...proof,
		...repositoryProof,
		outcome: z.literal("completed"),
	}),
	z.strictObject({
		...fence,
		...proof,
		outcome: z.literal("incomplete"),
		remaining: z.string().min(1).max(1800),
	}),
	// The change is on main, but its result could not be confirmed.
	z.strictObject({
		...fence,
		...proof,
		...repositoryProof,
		outcome: z.literal("landed_unverified"),
		unverified: z.string().min(1).max(1800),
		// The run changed nothing: these earlier commits on main already meet
		// the outcome. The runner checks each one before it counts.
		existingCommits: z
			.array(z.string().regex(/^[a-f0-9]{40}$/))
			.min(1)
			.max(10)
			.optional(),
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
		// A wait only a date can end; the runner records it as the Work's start date.
		notBefore: z.iso.datetime().optional(),
	}),
	z.strictObject({
		...fence,
		outcome: z.literal("already_satisfied"),
		// Retain older receipts so one missing approval cannot stop the whole dispatcher.
		ciApprovalId: z.uuid().optional(),
		commitSha: z.string().regex(/^[a-f0-9]{40}$/),
		runId: z.number().int().positive(),
		workflowName: z.string().min(1).max(300),
		minimumCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
		rootCause: z.string().min(10).max(1000),
	}),
]);
export type LaneResult = z.infer<typeof LaneResultSchema>;

// Structured Outputs requires an object root and every property to be required.
// Fields absent from an outcome use null; the strict outcome schema still decides
// which non-null fields are allowed and required when the dispatcher reads them.
const codexResultVariants = LaneResultSchema.options.map((option) =>
	z.toJSONSchema(option, { target: "draft-7" }),
);
const codexResultKeys = [
	...new Set(
		codexResultVariants.flatMap((variant) => Object.keys(variant.properties!)),
	),
];
export const CodexLaneResultJsonSchema = {
	type: "object" as const,
	additionalProperties: false,
	properties: Object.fromEntries(
		codexResultKeys.map((key) => {
			const schemas = new Map(
				codexResultVariants.flatMap((variant) => {
					const schema = variant.properties![key];
					return typeof schema === "object"
						? [[JSON.stringify(schema), schema] as const]
						: [];
				}),
			);
			if (
				codexResultVariants.some((variant) => !variant.required?.includes(key))
			)
				schemas.set('"null"', { type: "null" });
			const variants = [...schemas.values()];
			return [key, variants.length === 1 ? variants[0]! : { anyOf: variants }];
		}),
	),
	required: codexResultKeys,
};

export function parseCodexLaneResult(message: string): LaneResult {
	const value: unknown = JSON.parse(message);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return LaneResultSchema.parse(value);
	return LaneResultSchema.parse(
		Object.fromEntries(
			Object.entries(value).filter(
				([key, field]) => field !== null || !codexResultKeys.includes(key),
			),
		),
	);
}
export type LaneWait = Extract<LaneResult, { outcome: "waiting_on_user" }>;
export type LaneDeferral = Extract<LaneResult, { outcome: "deferred" }>;
export type ExistingLaneResult = Extract<
	LaneResult,
	{ outcome: "already_satisfied" }
>;
type RepositoryCapableLaneResult = Extract<
	LaneResult,
	{ outcome: "completed" | "landed_unverified" }
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
	const parsed = safeParseServerResponse(GetWorkInteractionResultSchema, value);
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

/**
 * A request that is no longer open can never produce the verified human
 * response a wait needs: it was cancelled, expired, or closed some other way.
 * The wait releases so the lane re-checks the Work instead of holding forever.
 */
export function laneWaitTerminal(wait: LaneWait, value: unknown): boolean {
	const parsed = safeParseServerResponse(GetWorkInteractionResultSchema, value);
	if (!parsed.success) return false;
	const { request, effectiveState } = parsed.data;
	return (
		request.id === wait.interactionId &&
		request.orgId === wait.orgId &&
		request.workItemId === wait.workItemId &&
		effectiveState !== "open"
	);
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

const githubRepository = (remote: string) =>
	/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
		remote,
	)?.[1];

const command = (repo: string, executable: string, args: string[]) =>
	execFileSync(executable, args, {
		cwd: repo,
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	}).trim();

/** The approval ledger pins criteria separately from the accepted outcome text. */
const CiRecoveryCriteriaSchema = z.strictObject({
	contractVersion: z.number().int().positive(),
	outcomeText: z.string().min(1).max(2000),
	repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
	workflowId: z.number().int().positive(),
	workflowName: z.string().min(1).max(300),
	workflowPath: z.string().regex(/^\.github\/workflows\/[\w.-]+\.ya?ml$/),
	runId: z.number().int().positive(),
	runAttempt: z.number().int().positive(),
	runName: z.string().min(1).max(300),
	runCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
	minimumCommit: z.string().regex(/^[a-f0-9]{40}$/),
	// Push gates cannot stand in for scheduled or explicitly requested full runs.
	event: z.enum(["schedule", "workflow_dispatch"]),
	requiredJobs: z.array(z.string().min(1).max(300)).min(1).max(500),
});

export function verifyExistingLaneResult(
	repo: string,
	result: ExistingLaneResult,
	run = (executable: string, args: string[]) => command(repo, executable, args),
	authorization?: { orgId: string; response: unknown },
) {
	const approval = safeParseServerResponse(
		ListWorkApprovalInboxResultSchema.extend({
			data: z.array(
				ListWorkApprovalInboxResultSchema.shape.data.element.pick({
					proposal: true,
					effectiveStatus: true,
					decision: true,
				}),
			),
		}),
		authorization?.response,
	);
	if (!approval.success)
		throw new LaneOutcomeReadError(
			"CI recovery approval receipt is unavailable",
		);
	const rows = approval.data;
	const row = rows.data[0];
	if (
		rows.hasMore ||
		rows.nextCursor !== null ||
		rows.data.length !== 1 ||
		!row ||
		row.proposal.id !== result.ciApprovalId ||
		row.proposal.orgId !== authorization?.orgId ||
		row.proposal.workItemId !== result.workItemId ||
		row.proposal.workItemVersion !== result.workVersion ||
		row.proposal.action !== "admission" ||
		row.proposal.authorityKey !== "ci:recovery" ||
		row.effectiveStatus !== "approved" ||
		row.proposal.status !== "approved" ||
		row.decision?.decision !== "approved" ||
		row.decision.proposalId !== row.proposal.id ||
		row.decision.resolvedProposalVersion !== row.proposal.version ||
		row.decision.deciderType !== row.proposal.approverType ||
		row.decision.deciderId !== row.proposal.approverId
	)
		throw new Error(
			"CI recovery requires the exact approved Work revision receipt",
		);
	const criteria = CiRecoveryCriteriaSchema.parse(
		row.proposal.proposal.ciRecovery,
	);
	if (
		criteria.contractVersion !== result.contractVersion ||
		criteria.outcomeText !== result.outcomeText ||
		criteria.runId !== result.runId ||
		criteria.workflowName !== result.workflowName ||
		criteria.minimumCommit !== result.minimumCommit
	)
		throw new Error("CI recovery declaration differs from approved criteria");
	const repository = githubRepository(
		run("git", ["remote", "get-url", "origin"]),
	);
	if (repository !== criteria.repository)
		throw new Error("CI recovery approval does not match the checkout origin");
	let proof;
	let workflow;
	let jobs;
	let latestFullRuns;
	const fullRunSchema = ciRunSchema.extend({
		event: z.string(),
		path: z.string(),
		run_number: z.number().int().positive(),
	});
	try {
		run("git", [
			"fetch",
			"--no-tags",
			"origin",
			"refs/heads/main:refs/remotes/origin/main",
		]);
		proof = fullRunSchema.parse(
			JSON.parse(
				run("gh", ["api", `repos/${repository}/actions/runs/${result.runId}`]),
			),
		);
		workflow = z
			.object({ id: z.number(), name: z.string(), path: z.string() })
			.parse(
				JSON.parse(
					run("gh", [
						"api",
						`repos/${repository}/actions/workflows/${criteria.workflowId}`,
					]),
				),
			);
		latestFullRuns = ["schedule", "workflow_dispatch"].flatMap(
			(event) =>
				z
					.object({ workflow_runs: z.array(fullRunSchema).max(1) })
					.parse(
						JSON.parse(
							run("gh", [
								"api",
								`repos/${repository}/actions/workflows/${criteria.workflowId}/runs?branch=main&event=${event}&per_page=1`,
							]),
						),
					).workflow_runs,
		);
		// Read this attempt only; a successful job from an earlier attempt is not proof.
		jobs = z
			.object({
				total_count: z.number().int().nonnegative(),
				jobs: z.array(
					z.object({
						name: z.string(),
						status: z.string(),
						conclusion: z.string().nullable(),
					}),
				),
			})
			.parse(
				JSON.parse(
					run("gh", [
						"api",
						"--paginate",
						"--slurp",
						`repos/${repository}/actions/runs/${result.runId}/attempts/${criteria.runAttempt}/jobs?per_page=100`,
					]),
				).reduce(
					(
						all: { total_count: number; jobs: unknown[] },
						page: { total_count: number; jobs: unknown[] },
					) => ({
						total_count: page.total_count,
						jobs: [...all.jobs, ...page.jobs],
					}),
					{ total_count: 0, jobs: [] },
				),
			);
	} catch (error) {
		throw new LaneOutcomeReadError(String(error));
	}
	const sha = proof.head_sha;
	if (
		!latestFullRuns.some(
			(latest) =>
				latest.id === proof.id &&
				latest.run_attempt === proof.run_attempt &&
				latest.head_sha === sha &&
				latest.status === "completed" &&
				latest.conclusion === "success",
		) ||
		latestFullRuns.some(
			(latest) =>
				latest.run_number > proof.run_number ||
				(latest.run_number === proof.run_number && latest.id !== proof.id),
		) ||
		proof.id !== criteria.runId ||
		proof.workflow_id !== criteria.workflowId ||
		proof.run_attempt !== criteria.runAttempt ||
		proof.name !== criteria.runName ||
		proof.event !== criteria.event ||
		proof.path !== criteria.workflowPath ||
		workflow.id !== criteria.workflowId ||
		workflow.name !== criteria.workflowName ||
		workflow.path !== criteria.workflowPath ||
		sha !== criteria.runCommitSha ||
		proof.status !== "completed" ||
		proof.conclusion !== "success" ||
		proof.head_branch !== "main" ||
		jobs.total_count !== jobs.jobs.length ||
		criteria.requiredJobs.some((name) => {
			const matches = jobs.jobs.filter((job) => job.name === name);
			return (
				matches.length !== 1 ||
				matches[0]!.status !== "completed" ||
				matches[0]!.conclusion !== "success"
			);
		})
	)
		throw new Error(
			"CI recovery does not match the approved successful full-run identity and jobs",
		);
	for (const [ancestor, descendant] of [
		[result.commitSha, sha],
		[criteria.minimumCommit, sha],
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
		ciApprovalId: result.ciApprovalId,
	};
}

/** Verifies a result landed in another repository owned beside this checkout. */
export function verifyRepositoryLaneResult(
	repo: string,
	result: RepositoryCapableLaneResult,
	run = (executable: string, args: string[]) => command(repo, executable, args),
) {
	const repositoryProof = result.repositoryProof;
	if (!repositoryProof) throw new Error("Repository proof is required");
	const source = githubRepository(run("git", ["remote", "get-url", "origin"]));
	if (!source)
		throw new Error("Repository proof requires the checkout's GitHub origin");
	const target = repositoryProof.repository;
	if (
		target.split("/")[0]!.toLowerCase() !== source.split("/")[0]!.toLowerCase()
	)
		throw new Error("Repository proof must target an allowed GitHub owner");

	let proof: z.infer<typeof ciRunSchema>;
	let latest: z.infer<typeof ciRunSchema>;
	let main: string;
	try {
		proof = ciRunSchema.parse(
			JSON.parse(
				run("gh", [
					"api",
					`repos/${target}/actions/runs/${repositoryProof.runId}`,
				]),
			),
		);
		latest = z
			.object({ workflow_runs: z.array(ciRunSchema).length(1) })
			.parse(
				JSON.parse(
					run("gh", [
						"api",
						`repos/${target}/actions/workflows/${proof.workflow_id}/runs?branch=main&per_page=1`,
					]),
				),
			).workflow_runs[0]!;
		main = z
			.object({ object: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }) })
			.parse(
				JSON.parse(run("gh", ["api", `repos/${target}/git/ref/heads/main`])),
			).object.sha;
	} catch (error) {
		throw new LaneOutcomeReadError(String(error));
	}
	if (
		proof.id !== repositoryProof.runId ||
		proof.name !== repositoryProof.workflowName ||
		proof.status !== "completed" ||
		proof.conclusion !== "success" ||
		proof.head_branch !== "main" ||
		latest.id !== proof.id ||
		latest.run_attempt !== proof.run_attempt ||
		latest.status !== "completed" ||
		latest.conclusion !== "success" ||
		latest.head_sha !== proof.head_sha
	)
		throw new Error(
			"Repository proof is not the latest successful main workflow run",
		);
	for (const [ancestor, descendant] of [
		[repositoryProof.commitSha, proof.head_sha],
		[proof.head_sha, main],
	]) {
		try {
			z
				.object({ status: z.enum(["ahead", "identical"]) })
				.parse(
					JSON.parse(
						run("gh", [
							"api",
							`repos/${target}/compare/${ancestor}...${descendant}`,
						]),
					),
				).status;
		} catch (error) {
			if (error instanceof z.ZodError)
				throw new Error("Repository proof commits are not on target main");
			throw new LaneOutcomeReadError(String(error));
		}
	}
	return {
		mode: "repository_commit" as const,
		repository: target,
		commitSha: repositoryProof.commitSha,
		runId: proof.id,
		runAttempt: proof.run_attempt,
		runCommitSha: proof.head_sha,
		evidenceUri: `https://github.com/${target}/actions/runs/${proof.id}`,
	};
}
