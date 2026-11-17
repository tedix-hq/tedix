import { describe, expect, it } from "bun:test";
import * as z from "zod";
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import { zodToToolInputJsonSchema } from "@tedix/api-contract/utils/tool-json-schema";
import {
	LaneOutcomeReadError,
	laneWaitResponse,
	laneWaitTerminal,
	parseLaneResult,
	verifyExistingLaneResult,
	verifyRepositoryLaneResult,
	type ExistingLaneResult,
	type LaneWait,
} from "./lane-result";

const wait: LaneWait = {
	outcome: "waiting_on_user",
	workItemId: "11111111-1111-4111-8111-111111111111",
	workVersion: 2,
	contractVersion: 1,
	outcomeText: "Confirm owner controls",
	interactionId: "22222222-2222-4222-8222-222222222222",
	requestVersion: 1,
	orgId: "33333333-3333-4333-8333-333333333333",
	userId: "fictional-owner",
};
const responseId = "44444444-4444-4444-8444-444444444444";
function interaction() {
	const at = "2026-10-31T12:00:00.000Z";
	return {
		request: {
			id: wait.interactionId,
			orgId: wait.orgId,
			workItemId: wait.workItemId,
			caseId: null,
			projectId: null,
			kind: "question",
			subject: "Confirm controls",
			prompt: "Confirm controls",
			requestedFromType: "user",
			requestedFromId: wait.userId,
			creatorType: "user",
			creatorId: "requester",
			creatorSessionId: null,
			state: "resolved",
			requestedAt: at,
			dueAt: null,
			expiresAt: null,
			resolvedAt: at,
			version: 2,
			metadata: {},
		},
		effectiveState: "resolved",
		canRespond: false,
		canCancel: false,
		responses: {
			data: [
				{
					id: responseId,
					requestId: wait.interactionId,
					responseKind: "answer",
					body: "Done; resume the check",
					artifactRef: null,
					artifactVersion: null,
					artifactDigest: null,
					resolvesRequest: true,
					respondedByType: "user",
					respondedById: wait.userId,
					respondedBySessionId: null,
					respondedAt: at,
					metadata: {},
				},
			],
			nextCursor: null,
			hasMore: false,
		},
	};
}

describe("structured lane results", () => {
	it.each(["completed", "incomplete"] as const)(
		"retains declared commit and evidence through strict %s parsing and settlement input",
		(outcome) => {
			const result = {
				workItemId: wait.workItemId,
				workVersion: wait.workVersion,
				contractVersion: wait.contractVersion,
				outcomeText: wait.outcomeText,
				...(outcome === "incomplete"
					? { outcome, remaining: "Live proof remains unknown" }
					: { outcome }),
				commitSha: "a".repeat(40),
				evidenceRefs: [responseId],
			};
			const line = (value: unknown) =>
				`TEDIX_LANE_RESULT ${JSON.stringify(value)}`;
			const parsed = parseLaneResult(line(result));
			expect(parsed).toEqual(result);
			const input = {
				id: result.workItemId,
				attemptId: wait.interactionId,
				outcome: outcome === "completed" ? "succeeded" : "failed",
				metadata: { session: "codex:fictional-session", laneResult: parsed },
			};
			const schema = workItemsContract.settleAttempt["~orpc"]
				.inputSchemas![0] as z.ZodType;
			const parameters: Record<string, unknown> =
				zodToToolInputJsonSchema(schema);
			const nativeInput = z.fromJSONSchema(parameters);
			expect(nativeInput.parse(input)).toEqual(input);
			expect(schema.parse(input)).toEqual(input);
			expect(zodToToolInputJsonSchema(schema).properties).not.toHaveProperty(
				"commitSha",
			);
			for (const bad of [
				{ ...result, ignored: true },
				{ ...result, commitSha: "abc123" },
				{ ...result, evidenceRefs: [""] },
				{ ...result, evidenceRefs: [42] },
				{ ...result, evidenceRefs: ["x".repeat(2001)] },
				{ ...result, evidenceRefs: Array(31).fill(responseId) },
			])
				expect(() => parseLaneResult(line(bad))).toThrow();
		},
	);
	it("distinguishes complete and incomplete accepted outcomes", () => {
		const { interactionId, requestVersion, orgId, userId, ...base } = wait;
		expect(
			parseLaneResult(
				`TEDIX_LANE_RESULT ${JSON.stringify({ ...base, outcome: "completed" })}`,
			)?.outcome,
		).toBe("completed");
		expect(
			parseLaneResult(
				`TEDIX_LANE_RESULT ${JSON.stringify({ ...base, outcome: "incomplete", remaining: "Live verification remains" })}`,
			)?.outcome,
		).toBe("incomplete");
		expect(() =>
			parseLaneResult(
				`TEDIX_LANE_RESULT ${JSON.stringify({ ...base, outcome: "incomplete" })}`,
			),
		).toThrow();
	});
	it("accepts only bounded repository proof on successful outcomes", () => {
		const { interactionId, requestVersion, orgId, userId, ...base } = wait;
		const repositoryProof = {
			repository: "example/operations",
			commitSha: "a".repeat(40),
			runId: 123,
			workflowName: "Deploy tests",
		};
		expect(
			parseLaneResult(
				`TEDIX_LANE_RESULT ${JSON.stringify({ ...base, outcome: "completed", repositoryProof })}`,
			),
		).toMatchObject({ repositoryProof });
		for (const bad of [
			{ ...repositoryProof, repository: "other" },
			{ ...repositoryProof, commitSha: "abc123" },
			{ ...repositoryProof, extra: true },
		])
			expect(() =>
				parseLaneResult(
					`TEDIX_LANE_RESULT ${JSON.stringify({ ...base, outcome: "completed", repositoryProof: bad })}`,
				),
			).toThrow();
	});
	it("ignores prose and accepts exactly one strict, bounded result", () => {
		expect(parseLaneResult("Still waiting on you")).toBeUndefined();
		const line = `TEDIX_LANE_RESULT ${JSON.stringify(wait)}`;
		expect(parseLaneResult(line)).toEqual(wait);
		for (const bad of [
			line + "\n" + line,
			"TEDIX_LANE_RESULT {}",
			line.replace("waiting_on_user", "succeeded"),
			`TEDIX_LANE_RESULT ${JSON.stringify({ ...wait, approve: true })}`,
			"TEDIX_LANE_RESULT " + "x".repeat(6000),
		])
			expect(() => parseLaneResult(bad)).toThrow();
	});
	it("releases only a complete resolving response from the exact human", () => {
		expect(laneWaitResponse(wait, interaction())).toBe(responseId);
		// A runner on an older CLI still sees the answer when the server adds fields.
		const newer = structuredClone(interaction()) as Record<string, any>;
		newer.addedByServer = true;
		newer.request.addedByServer = { since: "next release" };
		newer.responses.data[0].addedByServer = 1;
		expect(laneWaitResponse(wait, newer)).toBe(responseId);
		expect(laneWaitTerminal(wait, newer)).toBe(true);
		delete newer.request.version;
		expect(laneWaitResponse(wait, newer)).toBeUndefined();
		const cases = [
			(v: ReturnType<typeof interaction>) => {
				v.request.workItemId = responseId;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.orgId = responseId;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.id = responseId;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.version = 1;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.state = "cancelled";
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.state = "expired";
			},
			(v: ReturnType<typeof interaction>) => {
				v.effectiveState = "open";
			},
			(v: ReturnType<typeof interaction>) => {
				v.responses.hasMore = true;
			},
			(v: ReturnType<typeof interaction>) => {
				v.responses.data[0]!.resolvesRequest = false;
			},
			(v: ReturnType<typeof interaction>) => {
				v.responses.data[0]!.respondedById = "another-user";
			},
			(v: ReturnType<typeof interaction>) => {
				v.responses.data[0]!.respondedByType = "external_agent";
			},
			(v: ReturnType<typeof interaction>) => {
				v.responses.data[0]!.responseKind = "handoff_declined";
			},
		];
		for (const change of cases) {
			const value = interaction();
			change(value);
			expect(laneWaitResponse(wait, value)).toBeUndefined();
		}
		expect(laneWaitResponse(wait, {})).toBeUndefined();
	});
	it("treats a wait request as terminal only when closed inside its own fence", () => {
		for (const state of ["cancelled", "expired", "resolved"] as const) {
			const value = interaction();
			value.request.state = state;
			value.effectiveState = state;
			value.responses.data = [];
			expect(laneWaitTerminal(wait, value)).toBe(true);
		}
		const lapsed = interaction();
		lapsed.request.state = "open";
		lapsed.effectiveState = "expired";
		lapsed.responses.data = [];
		expect(laneWaitTerminal(wait, lapsed)).toBe(true);
		const open = interaction();
		open.request.state = "open";
		open.effectiveState = "open";
		expect(laneWaitTerminal(wait, open)).toBe(false);
		for (const change of [
			(v: ReturnType<typeof interaction>) => {
				v.request.id = responseId;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.orgId = responseId;
			},
			(v: ReturnType<typeof interaction>) => {
				v.request.workItemId = responseId;
			},
		]) {
			const value = interaction();
			change(value);
			expect(laneWaitTerminal(wait, value)).toBe(false);
		}
		expect(laneWaitTerminal(wait, {})).toBe(false);
	});
});

const existing: ExistingLaneResult = {
	workItemId: wait.workItemId,
	workVersion: 2,
	contractVersion: 1,
	outcomeText:
		"The failing tests are fixed or the proven culprit is reverted, and the full test suite is green on main again.",
	outcome: "already_satisfied",
	ciApprovalId: responseId,
	commitSha: "b".repeat(40),
	runId: 123,
	workflowName: "Deploy gate (push) and full test run (every 8 hours)",
	minimumCommit: "a".repeat(40),
	rootCause: "Fixture parity mismatch",
};
function proofFixture() {
	const at = "2026-11-01T12:00:00.000Z";
	const proof = {
		id: 123,
		workflow_id: 456,
		run_number: 100,
		run_attempt: 1,
		name: `Full test run @ ${"c".repeat(40)}`,
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: "c".repeat(40),
		event: "workflow_dispatch",
		path: ".github/workflows/full-suite-hourly.yml",
	};
	const workflow = { id: 456, name: existing.workflowName, path: proof.path };
	const criteria = {
		contractVersion: 1,
		outcomeText: existing.outcomeText,
		repository: "example/project",
		workflowId: 456,
		workflowName: workflow.name,
		workflowPath: workflow.path,
		runId: 123,
		runAttempt: 1,
		runName: proof.name,
		runCommitSha: proof.head_sha,
		minimumCommit: existing.minimumCommit,
		event: "workflow_dispatch",
		requiredJobs: ["Workspace CLI", "Workspace OS"],
	};
	const proposal = {
		id: responseId,
		orgId: wait.orgId,
		workItemId: existing.workItemId,
		workItemVersion: 2,
		action: "admission",
		authorityKey: "ci:recovery",
		proposal: { ciRecovery: criteria },
		approverType: "tedi",
		approverId: "reviewer",
		requestRationale: "Verify exact full-suite recovery",
		requestedByType: "external_agent",
		requestedById: "executor",
		requestedBySessionId: null,
		status: "approved",
		requestedAt: at,
		expiresAt: "2026-12-01T12:00:00.000Z",
		resolvedAt: at,
		version: 2,
	};
	const decision = {
		id: wait.interactionId,
		proposalId: responseId,
		resolvedProposalVersion: 2,
		decision: "approved",
		deciderType: "tedi",
		deciderId: "reviewer",
		rationale: "Full suite required",
		decidedAt: at,
	};
	const row = { proposal, decision, effectiveStatus: "approved" };
	const authorization = {
		orgId: wait.orgId,
		response: { data: [row], hasMore: false, nextCursor: null, observedAt: at },
	};
	const pages = [
		{
			total_count: 2,
			jobs: criteria.requiredJobs.map((name) => ({
				name,
				status: "completed",
				conclusion: "success",
			})),
		},
	];
	const latest = { workflow_runs: [{ ...proof }] };
	const commands: string[][] = [];
	let failure = "";
	const run = (executable: string, args: string[]) => {
		commands.push([executable, ...args]);
		if (args.includes(failure)) throw new Error("unavailable");
		if (executable === "gh") {
			if (args.includes("--paginate")) return JSON.stringify(pages);
			if (args[1]!.includes("/runs?"))
				return JSON.stringify(
					args[1]!.includes("event=schedule") ? { workflow_runs: [] } : latest,
				);
			return JSON.stringify(
				args[1]!.includes("/workflows/") ? workflow : proof,
			);
		}
		if (args[0] === "remote") return "https://github.com/example/project.git";
		return "";
	};
	return {
		proof,
		latest,
		workflow,
		criteria,
		proposal,
		decision,
		row,
		authorization,
		pages,
		commands,
		fail: (value: string) => {
			failure = value;
		},
		run,
		verify: (result = existing) =>
			verifyExistingLaneResult("/fictional", result, run, authorization),
	};
}
describe("verified preexisting CI outcomes", () => {
	it("admits the unchanged generic incident outcome using exact approved CI identity", () => {
		const f = proofFixture();
		expect(
			parseLaneResult(`TEDIX_LANE_RESULT ${JSON.stringify(existing)}`),
		).toEqual(existing);
		expect(f.verify()).toMatchObject({
			mode: "verified_existing",
			commitSha: existing.commitSha,
			runId: 123,
			ciApprovalId: responseId,
			evidenceUri: "https://github.com/example/project/actions/runs/123",
		});
		expect(
			f.commands.filter((args) => args.includes("--is-ancestor")),
		).toHaveLength(3);
		// Latest full runs are selected by event, excluding newer push gates.
		expect(
			f.commands
				.filter((args) => args.some((arg) => arg.includes("/runs?")))
				.map((args) => args.at(-1)),
		).toEqual([
			"repos/example/project/actions/workflows/456/runs?branch=main&event=schedule&per_page=1",
			"repos/example/project/actions/workflows/456/runs?branch=main&event=workflow_dispatch&per_page=1",
		]);
		expect(
			f.commands.some((args) =>
				args.some((arg) => arg.includes("/attempts/1/jobs")),
			),
		).toBe(true);
	});
	it("reads all pages of the authorized attempt's jobs", () => {
		const f = proofFixture();
		const last = f.pages[0]!.jobs.pop()!;
		f.pages.push({ total_count: 2, jobs: [last] });
		expect(f.verify().runId).toBe(123);
	});
	it.each([
		"newerFullRun",
		"latestAttempt",
		"runName",
		"workflowName",
		"workflowId",
		"attempt",
		"sha",
		"failed",
		"pending",
		"branch",
		"pushGate",
		"missingJob",
		"skippedJob",
		"failedJob",
		"truncatedJobs",
		"ancestry",
		"workVersion",
		"org",
		"proposalId",
		"authority",
		"pendingApproval",
		"rejected",
		"receiptVersion",
		"decider",
		"contractVersion",
		"outcomeText",
		"minimum",
		"repository",
	])("rejects invalid immutable proof: %s", (mode) => {
		const f = proofFixture();
		switch (mode) {
			case "newerFullRun":
				f.latest.workflow_runs[0]!.id++;
				f.latest.workflow_runs[0]!.run_number++;
				f.latest.workflow_runs[0]!.conclusion = "failure";
				break;
			case "latestAttempt":
				f.latest.workflow_runs[0]!.run_attempt++;
				break;
			case "runName":
				f.proof.name = f.workflow.name;
				break;
			case "workflowName":
				f.workflow.name = f.proof.name;
				break;
			case "workflowId":
				f.proof.workflow_id++;
				break;
			case "attempt":
				f.proof.run_attempt++;
				break;
			case "sha":
				f.proof.head_sha = "d".repeat(40);
				break;
			case "failed":
				f.proof.conclusion = "failure";
				break;
			case "pending":
				f.proof.status = "in_progress";
				break;
			case "branch":
				f.proof.head_branch = "feature";
				break;
			case "pushGate":
				f.proof.event = "push";
				f.proof.name = "Deploy gate @ " + f.proof.head_sha;
				break;
			case "missingJob":
				f.pages[0]!.jobs.pop();
				f.pages[0]!.total_count--;
				break;
			case "skippedJob":
				f.pages[0]!.jobs[0]!.conclusion = "skipped";
				break;
			case "failedJob":
				f.pages[0]!.jobs[0]!.conclusion = "failure";
				break;
			case "truncatedJobs":
				f.pages[0]!.total_count++;
				break;
			case "ancestry":
				f.fail("--is-ancestor");
				break;
			case "workVersion":
				f.proposal.workItemVersion++;
				break;
			case "org":
				f.authorization.orgId = wait.interactionId;
				break;
			case "proposalId":
				f.proposal.id = wait.interactionId;
				break;
			case "authority":
				f.proposal.authorityKey = "risk:high";
				break;
			case "pendingApproval":
				f.row.effectiveStatus = "pending";
				break;
			case "rejected":
				f.decision.decision = "rejected";
				break;
			case "receiptVersion":
				f.decision.resolvedProposalVersion++;
				break;
			case "decider":
				f.decision.deciderId = "someone-else";
				break;
			case "contractVersion":
				f.criteria.contractVersion++;
				break;
			case "outcomeText":
				f.criteria.outcomeText = "Rewritten outcome";
				break;
			case "minimum":
				f.criteria.minimumCommit = "d".repeat(40);
				break;
			case "repository":
				f.criteria.repository = "example/other";
				break;
		}
		expect(() => f.verify()).toThrow();
	});
	it("retains unavailable approval or provider reads", () => {
		const f = proofFixture();
		const legacy = { ...existing, ciApprovalId: undefined };
		expect(
			parseLaneResult(`TEDIX_LANE_RESULT ${JSON.stringify(legacy)}`),
		).toMatchObject({ outcome: "already_satisfied" });
		expect(() => f.verify(legacy)).toThrow();
		expect(() =>
			verifyExistingLaneResult("/fictional", existing, f.run),
		).toThrow(LaneOutcomeReadError);
		f.fail("api");
		expect(() => f.verify()).toThrow(LaneOutcomeReadError);
	});
});

function repositoryFixture() {
	const proof = {
		id: 123,
		workflow_id: 456,
		run_attempt: 1,
		name: "Deploy tests",
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: "c".repeat(40),
	};
	const latest = { workflow_runs: [{ ...proof }] };
	const commands: string[][] = [];
	return {
		proof,
		latest,
		commands,
		compareStatus: "ahead",
		run(executable: string, args: string[]) {
			commands.push([executable, ...args]);
			if (executable === "git") return "git@github.com:example/product.git";
			const path = args[1]!;
			if (path.includes("/actions/runs/")) return JSON.stringify(proof);
			if (path.includes("/actions/workflows/")) return JSON.stringify(latest);
			if (path.includes("/git/ref/heads/main"))
				return JSON.stringify({ object: { sha: "d".repeat(40) } });
			if (path.includes("/compare/"))
				return JSON.stringify({ status: this.compareStatus });
			throw new Error(`Unexpected command: ${path}`);
		},
	};
}

describe("target repository results", () => {
	const result = {
		...existing,
		outcome: "completed" as const,
		repositoryProof: {
			repository: "example/operations",
			commitSha: "b".repeat(40),
			runId: 123,
			workflowName: "Deploy tests",
		},
	};
	it("verifies an allowed repository's main ancestry and latest green CI", () => {
		const f = repositoryFixture();
		expect(
			verifyRepositoryLaneResult("/fictional", result, f.run.bind(f)),
		).toEqual({
			mode: "repository_commit",
			repository: "example/operations",
			commitSha: "b".repeat(40),
			runId: 123,
			runAttempt: 1,
			runCommitSha: "c".repeat(40),
			evidenceUri: "https://github.com/example/operations/actions/runs/123",
		});
		expect(
			f.commands.filter((command) => command[2]?.includes("/compare/")),
		).toHaveLength(2);
	});
	it("rejects repositories outside the checkout owner and non-ancestral commits", () => {
		const f = repositoryFixture();
		expect(() =>
			verifyRepositoryLaneResult(
				"/fictional",
				{
					...result,
					repositoryProof: {
						...result.repositoryProof,
						repository: "other/operations",
					},
				},
				f.run.bind(f),
			),
		).toThrow("allowed GitHub owner");
		f.compareStatus = "diverged";
		expect(() =>
			verifyRepositoryLaneResult("/fictional", result, f.run.bind(f)),
		).toThrow("not on target main");
	});
	it("rejects stale or unsuccessful target CI", () => {
		for (const change of [
			(f: ReturnType<typeof repositoryFixture>) => {
				f.proof.conclusion = "failure";
			},
			(f: ReturnType<typeof repositoryFixture>) => {
				f.latest.workflow_runs[0]!.id = 999;
			},
		]) {
			const f = repositoryFixture();
			change(f);
			expect(() =>
				verifyRepositoryLaneResult("/fictional", result, f.run.bind(f)),
			).toThrow("latest successful main workflow run");
		}
	});
});
