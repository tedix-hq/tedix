import { describe, expect, it } from "bun:test";
import {
	LaneOutcomeReadError,
	laneWaitResponse,
	parseLaneResult,
	verifyExistingLaneResult,
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
});

const existing: ExistingLaneResult = {
	workItemId: wait.workItemId,
	workVersion: 2,
	contractVersion: 1,
	outcomeText:
		"Full suite hourly is green again on a commit at or after abcdef1",
	outcome: "already_satisfied",
	commitSha: "b".repeat(40),
	runId: 123,
	workflowName: "Full suite hourly",
	minimumCommit: "abcdef1",
	rootCause: "Fixture parity mismatch",
};
function proofFixture() {
	const proof = {
		id: 123,
		workflow_id: 456,
		run_attempt: 1,
		name: existing.workflowName,
		status: "completed",
		conclusion: "success",
		head_branch: "main",
		head_sha: "c".repeat(40),
	};
	const latest = { workflow_runs: [{ ...proof }] };
	const commands: string[][] = [];
	let failure = "";
	return {
		proof,
		latest,
		commands,
		fail: (value: string) => {
			failure = value;
		},
		run: (executable: string, args: string[]) => {
			commands.push([executable, ...args]);
			if (args.includes(failure)) throw new Error("unavailable");
			if (executable === "gh")
				return JSON.stringify(
					args[1]!.includes("/workflows/") ? latest : proof,
				);
			if (args[0] === "remote") return "https://github.com/example/project.git";
			return "";
		},
	};
}
describe("verified preexisting CI outcomes", () => {
	it("records existing evidence without manufacturing an authored commit", () => {
		const f = proofFixture();
		expect(
			verifyExistingLaneResult("/fictional", existing, f.run),
		).toMatchObject({
			mode: "verified_existing",
			commitSha: existing.commitSha,
			runId: 123,
			evidenceUri: "https://github.com/example/project/actions/runs/123",
		});
		expect(
			f.commands.filter((args) => args.includes("--is-ancestor")),
		).toHaveLength(3);
	});
	it("rejects mismatched contracts, failed/stale/pending runs and unlanded fixes", () => {
		for (const change of [
			(f: ReturnType<typeof proofFixture>) => {
				f.proof.name = "Other workflow";
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.proof.conclusion = "failure";
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.proof.status = "in_progress";
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.proof.head_branch = "feature";
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.latest.workflow_runs[0]!.id = 999;
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.latest.workflow_runs[0]!.run_attempt = 2;
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.latest.workflow_runs[0]!.status = "in_progress";
			},
			(f: ReturnType<typeof proofFixture>) => {
				f.fail("--is-ancestor");
			},
		]) {
			const f = proofFixture();
			change(f);
			expect(() =>
				verifyExistingLaneResult("/fictional", existing, f.run),
			).toThrow();
		}
		const f = proofFixture();
		expect(() =>
			verifyExistingLaneResult(
				"/fictional",
				{ ...existing, minimumCommit: "fffffff" },
				f.run,
			),
		).toThrow();
		f.fail("api");
		expect(() =>
			verifyExistingLaneResult("/fictional", existing, f.run),
		).toThrow(LaneOutcomeReadError);
	});
});
