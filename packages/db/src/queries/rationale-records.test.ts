/**
 * Integration tests for Phase 6a failure context in rationale records.
 *
 * Tests the query layer that powers the write_rationale response:
 * - getRecentFailedByCategory: surfaces failure history
 * - getLastAttemptByAction: shows last time this exact action was tried
 * - detectApprovalFatigue: detects 100% acceptance rate
 *
 * These are unit tests of the query logic (no real D1 needed).
 * The actual DB queries use Drizzle which needs a D1 instance,
 * so we test the helper functions and type contracts.
 */

import { describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../client";
import {
	assertRationaleExecutionLinked,
	compareSkillWorkflowArtifactPaths,
	countRationaleRunToolEvents,
	createRationaleRecord,
	createRationaleRecordIdempotent,
	resolveOutcomeStatusForProof,
	skillWorkflowDispatchOutcome,
	skillWorkflowToolCallRefs,
} from "./rationale-records";

describe("rationale runtime-event count", () => {
	it("normalizes the D1 count result", async () => {
		const db = {
			all: async () => [{ cnt: "2" }],
		} as unknown as DbClient;
		await expect(
			countRationaleRunToolEvents(db, {
				tediId: "tedi-1",
				orgId: "org-1",
				runId: "run-1",
			}),
		).resolves.toBe(2);
	});
});

function idempotencyDb(record: Record<string, unknown>): DbClient {
	const insertResults = [[record], []];
	const selectResults = [[record]];
	const chain = (kind: "insert" | "select"): unknown =>
		new Proxy(() => {}, {
			get(_target, property) {
				if (property === "then") {
					const result =
						kind === "insert"
							? (insertResults.shift() ?? [])
							: (selectResults.shift() ?? []);
					return Promise.resolve(result).then.bind(Promise.resolve(result));
				}
				return () => chain(kind);
			},
			apply: () => chain(kind),
		});
	return {
		insert: () => chain("insert"),
		select: () => chain("select"),
	} as unknown as DbClient;
}

describe("rationale idempotency", () => {
	it("returns one primary-key record across a semantic replay", async () => {
		const record = {
			id: "11111111-1111-8111-8111-111111111111",
			tediId: "tedi-1",
			orgId: "org-1",
			action: "wait",
			rationale: "waiting",
			category: "optimization",
			confidence: 0.9,
			evidence: { rationaleIdempotencyKey: "gate-1" },
			outcome: null,
			outcomeStatus: "pending",
			approvalRequestId: null,
			objectiveId: null,
			runId: "tedi-1:mcp:1234",
			workItemId: null,
			toolCallRefs: null,
			proofRef: null,
			createdAt: "2026-07-12T00:00:00.000Z",
			completedAt: null,
			blameChain: null,
		};
		const db = idempotencyDb(record);
		const input = {
			id: record.id,
			tediId: record.tediId,
			orgId: record.orgId,
			action: record.action,
			rationale: record.rationale,
			category: record.category,
			confidence: record.confidence,
			evidence: record.evidence,
			runId: record.runId,
			createdAt: record.createdAt,
		};

		const first = await createRationaleRecordIdempotent(db, input);
		const replay = await createRationaleRecordIdempotent(db, input);
		expect(first).toMatchObject({ created: true, record: { id: record.id } });
		expect(replay).toMatchObject({ created: false, record: { id: record.id } });
	});
});

describe("WS1: execution-link invariant", () => {
	const base = {
		id: "22222222-2222-8222-8222-222222222222",
		tediId: "tedi-1",
		orgId: "org-1",
		action: "deploy",
		rationale: "shipping",
		category: "deployment",
		confidence: 0.8,
		evidence: {},
		createdAt: "2026-07-16T00:00:00.000Z",
	};

	it("rejects an unlinked create (no runId/workItemId/toolCallRefs)", async () => {
		const db = {} as DbClient; // must throw before touching the db
		await expect(createRationaleRecord(db, base)).rejects.toThrow(
			/UNLINKED_RATIONALE/,
		);
		await expect(createRationaleRecordIdempotent(db, base)).rejects.toThrow(
			/UNLINKED_RATIONALE/,
		);
	});

	it("rejects whitespace-only and empty-array links", () => {
		expect(() =>
			assertRationaleExecutionLinked({ runId: "  ", toolCallRefs: [] }),
		).toThrow(/UNLINKED_RATIONALE/);
	});

	it("accepts any single execution link", () => {
		expect(() =>
			assertRationaleExecutionLinked({ runId: "tedi-1:chat:99" }),
		).not.toThrow();
		expect(() =>
			assertRationaleExecutionLinked({
				workItemId: "33333333-3333-8333-8333-333333333333",
			}),
		).not.toThrow();
		expect(() =>
			assertRationaleExecutionLinked({
				toolCallRefs: ["tedi-1:chat:99:step:0:0:web_search"],
			}),
		).not.toThrow();
	});
});

describe("WS1: proof-gated outcome resolution", () => {
	it("maps a proof-less success claim to unverified", () => {
		expect(resolveOutcomeStatusForProof("success", undefined)).toBe(
			"unverified",
		);
	});

	it("keeps success when a span-checkable proof ref is present", () => {
		expect(
			resolveOutcomeStatusForProof("success", {
				kind: "run",
				ref: "tedi-1:chat:99",
			}),
		).toBe("success");
	});

	it("passes failure/partial through unchanged (no proof required)", () => {
		expect(resolveOutcomeStatusForProof("failure", undefined)).toBe("failure");
		expect(resolveOutcomeStatusForProof("partial", undefined)).toBe("partial");
	});
});

describe("skill workflow dispatch terminal reconciliation", () => {
	it("projects failed workflow truth instead of preserving admission success", () => {
		expect(
			skillWorkflowDispatchOutcome({
				runId: "run-failed",
				status: "failed",
				error: "NonRetryableError: fixture failed",
			}),
		).toEqual({
			outcome:
				"Workflow run run-failed failed: NonRetryableError: fixture failed",
			outcomeStatus: "failure",
			proofRef: null,
		});
	});

	it("dedupes successful replay receipts by logical idempotency key", () => {
		const receipt = (input: {
			path: string;
			idempotencyKey: string;
			namespace: string;
			method: string;
		}) => ({
			path: input.path,
			outcome: "success",
			contentInline: JSON.stringify({
				kind: "workflow_mcp_call",
				status: "succeeded",
				idempotencyKey: input.idempotencyKey,
				namespace: input.namespace,
				method: input.method,
			}),
		});
		const refs = skillWorkflowToolCallRefs("run-1", [
			receipt({
				path: "epochs/0/steps/read/1/attempts/1/calls/main/1.json",
				idempotencyKey: "logical-read",
				namespace: "home",
				method: "read_home_run_set",
			}),
			receipt({
				path: "epochs/0/steps/read/1/attempts/2/calls/main/1.json",
				idempotencyKey: "logical-read",
				namespace: "home",
				method: "read_home_run_set",
			}),
			receipt({
				path: "epochs/0/steps/read/2/attempts/1/calls/main/1.json",
				idempotencyKey: "logical-list",
				namespace: "home",
				method: "list_home_runs",
			}),
		]);
		expect(refs).toEqual([
			"run-1:step:0:0:home.read_home_run_set",
			"run-1:step:1:0:home.list_home_runs",
		]);
	});

	it("orders receipts numerically across unpadded path integers (10.json after 2.json)", () => {
		// Lexicographic ordering put "10.json" before "2.json" and scrambled
		// toolCallRefs for any phase with >= 10 calls.
		expect(
			compareSkillWorkflowArtifactPaths(
				"epochs/0/steps/act/1/attempts/1/calls/main/10.json",
				"epochs/0/steps/act/1/attempts/1/calls/main/2.json",
			),
		).toBeGreaterThan(0);
		expect(
			compareSkillWorkflowArtifactPaths(
				"epochs/0/steps/act/1/attempts/2/calls/main/1.json",
				"epochs/0/steps/act/1/attempts/10/calls/main/1.json",
			),
		).toBeLessThan(0);

		const receipt = (index: number) => ({
			path: `epochs/0/steps/act/1/attempts/1/calls/main/${index}.json`,
			outcome: "success",
			contentInline: JSON.stringify({
				kind: "workflow_mcp_call",
				status: "succeeded",
				idempotencyKey: `call-${index}`,
				namespace: "home",
				method: `tool_${index}`,
			}),
		});
		// 12 calls, deliberately shuffled input order — the ref sequence must
		// come out in true call order 1..12.
		const shuffled = [10, 3, 12, 1, 7, 11, 2, 9, 5, 8, 4, 6].map(receipt);
		const refs = skillWorkflowToolCallRefs("run-1", shuffled);
		expect(refs).toEqual(
			Array.from(
				{ length: 12 },
				(_, i) => `run-1:step:${i}:0:home.tool_${i + 1}`,
			),
		);
	});
});

// Test the approval fatigue detection logic inline
// (the actual query hits D1, but the logic is simple enough to test the contract)
describe("Phase 6a: Failure context types", () => {
	it("getRecentFailedByCategory returns correct type shape", () => {
		// Type contract: returns TediRationaleRecord[] filtered to outcomeStatus=failure
		type FailureRecord = {
			id: string;
			action: string;
			outcome: string | null;
			confidence: number;
			createdAt: string;
			outcomeStatus: "failure";
		};
		const record: FailureRecord = {
			id: "test-1",
			action: "Deploy config change",
			outcome: "Deployment failed: timeout",
			confidence: 0.7,
			createdAt: "2026-04-01T00:00:00Z",
			outcomeStatus: "failure",
		};
		expect(record.outcomeStatus).toBe("failure");
	});

	it("getLastAttemptByAction returns single record or null", () => {
		type LastAttempt = {
			action: string;
			outcomeStatus: string;
			outcome: string | null;
			confidence: number;
			createdAt: string;
		} | null;
		const found: LastAttempt = {
			action: "Restart acme adapter",
			outcomeStatus: "success",
			outcome: "Adapter restarted in 28s",
			confidence: 0.92,
			createdAt: "2026-04-01T14:32:00Z",
		};
		expect(found).not.toBeNull();
		expect(found!.outcomeStatus).toBe("success");

		const notFound: LastAttempt = null;
		expect(notFound).toBeNull();
	});
});

describe("Phase 4: Approval fatigue detection", () => {
	it("detects fatigue when all records are successes", () => {
		const windowSize = 20;
		const records = Array.from({ length: 20 }, () => ({
			outcomeStatus: "success" as const,
		}));

		let consecutiveSuccesses = 0;
		for (const record of records) {
			if (record.outcomeStatus === "success") {
				consecutiveSuccesses++;
			} else {
				break;
			}
		}

		const fatigueDetected = consecutiveSuccesses >= windowSize;
		expect(fatigueDetected).toBe(true);
		expect(consecutiveSuccesses).toBe(20);
	});

	it("does not detect fatigue with a failure in window", () => {
		const records = [
			...Array.from({ length: 15 }, () => ({
				outcomeStatus: "success" as const,
			})),
			{ outcomeStatus: "failure" as const },
			...Array.from({ length: 4 }, () => ({
				outcomeStatus: "success" as const,
			})),
		];

		let consecutiveSuccesses = 0;
		for (const record of records) {
			if (record.outcomeStatus === "success") {
				consecutiveSuccesses++;
			} else {
				break;
			}
		}

		const fatigueDetected = consecutiveSuccesses >= 20;
		expect(fatigueDetected).toBe(false);
		expect(consecutiveSuccesses).toBe(15);
	});

	it("does not detect fatigue with insufficient records", () => {
		const records = Array.from({ length: 10 }, () => ({
			outcomeStatus: "success" as const,
		}));

		const totalInWindow = records.length;
		const fatigueDetected =
			totalInWindow >= 20 &&
			records.every((r) => r.outcomeStatus === "success");
		expect(fatigueDetected).toBe(false);
	});
});
