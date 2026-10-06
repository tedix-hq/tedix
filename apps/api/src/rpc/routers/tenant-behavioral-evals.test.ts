import { describe, expect, it } from "vite-plus/test";
import {
	TenantBehavioralEvalRunDetailSchema,
	TenantBehavioralEvalRunSchema,
} from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import { TenantBehavioralEvalRunConflictError } from "@tedix/db/queries/tenant-behavioral-evals";
import {
	mapTenantBehavioralEvalRunConflict,
	tenantBehavioralEvalPublicDetail,
	tenantBehavioralEvalPublicRun,
	tenantBehavioralEvalsContractRouter,
} from "./tenant-behavioral-evals";
describe("tenant behavioral eval router", () => {
	it("registers only the admitted lifecycle", () => {
		expect(Object.keys(tenantBehavioralEvalsContractRouter)).toEqual([
			"create",
			"revise",
			"get",
			"list",
			"startRun",
			"getRun",
			"listRuns",
			"advanceRun",
		]);
	});
	it("strips private lease authority from run outputs", () => {
		const output = tenantBehavioralEvalPublicRun({
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			status: "running",
			version: 1,
			idempotencyKey: "key",
			payloadDigest: "digest",
			manifest: null,
			manifestDigest: null,
			leaseToken: "secret",
			leaseUntil: "later",
			passed: null,
			lastAdvanceError: null,
			lastAdvanceErrorPhase: null,
			lastAdvanceErrorRetryable: null,
			createdAt: "now",
			updatedAt: "now",
		});
		expect(TenantBehavioralEvalRunSchema.parse(output)).toEqual(output);
		expect(output).not.toHaveProperty("leaseToken");
	});
	it("normalizes case and assertion persistence rows through the strict detail schema", () => {
		const run = {
			id: "run",
			organizationId: "org",
			definitionId: "def",
			revisionId: "rev",
			tediId: "tedi",
			status: "running" as const,
			version: 1,
			idempotencyKey: "key",
			payloadDigest: "digest",
			manifest: null,
			manifestDigest: null,
			leaseToken: "secret",
			leaseUntil: "later",
			passed: null,
			lastAdvanceError: null,
			lastAdvanceErrorPhase: null,
			lastAdvanceErrorRetryable: null,
			createdAt: "now",
			updatedAt: "now",
		};
		const detail = tenantBehavioralEvalPublicDetail({
			run,
			caseRuns: [
				{
					id: "case",
					runId: "run",
					caseId: "c",
					homeRunId: "home",
					attemptNumber: 1,
					status: "completed",
					eventCursor: 2,
					sawClosed: true,
					drained: true,
					terminalStatus: "completed",
					selectedRoute: "answer",
					effectsSuppressed: true,
					error: null,
					disposition: "passed",
					executionReceipt: null,
					createdAt: "hidden",
					updatedAt: "hidden",
				},
			],
			caseAttempts: [],
			assertionResults: [
				{
					id: "assert",
					caseRunId: "case",
					assertionIndex: 0,
					type: "no_effects",
					passed: true,
					severity: "gate",
					disposition: "passed",
					detail: "ok",
					createdAt: "hidden",
				},
			],
		});
		expect(TenantBehavioralEvalRunDetailSchema.parse(detail)).toEqual(detail);
		expect(detail.caseRuns[0]).not.toHaveProperty("createdAt");
		expect(detail.assertionResults[0]).not.toHaveProperty("createdAt");
	});
	it("maps only the typed immutable run conflict", async () => {
		await expect(
			mapTenantBehavioralEvalRunConflict(async () => {
				throw new TenantBehavioralEvalRunConflictError();
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		const storageFailure = new Error("D1 unavailable");
		await expect(
			mapTenantBehavioralEvalRunConflict(async () => {
				throw storageFailure;
			}),
		).rejects.toBe(storageFailure);
	});
});
