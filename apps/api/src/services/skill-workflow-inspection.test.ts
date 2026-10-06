import { SkillWorkflowStepSchema } from "@tedix/api-contract/contracts/cognitive";
import type { SkillRunArtifact } from "@tedix/db/schema/cognitive";
import { describe, expect, it } from "vite-plus/test";
import {
	aggregateSkillWorkflowReliability,
	computeSkillRunCostSummary,
	parseSkillWorkflowRecords,
	resolveSkillRunArtifactContents,
} from "./skill-workflow-inspection";

function artifact(
	path: string,
	content: unknown,
	options?: {
		outcome?: "pending" | "success" | "failure";
		attempt?: number;
		runId?: string;
	},
) {
	const serialized = JSON.stringify(content);
	return {
		artifact: {
			id: crypto.randomUUID(),
			runId: options?.runId ?? "run-1",
			path,
			mimeType: "application/json",
			sizeBytes: serialized.length,
			contentInline: serialized,
			contentR2Key: null,
			sha256: null,
			attempt: options?.attempt ?? 1,
			outcome: options?.outcome ?? "success",
			createdAt: "2026-07-11T10:00:00.000Z",
		} satisfies SkillRunArtifact,
		content: serialized,
	};
}

describe("skill workflow inspection", () => {
	it("parses current nested call and rollback evidence while retaining flat attempts", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact("epochs/2/steps/x:research%20offers/1/attempts/1.json", {
				step: { id: "step-1" },
				status: "succeeded",
				durationMs: 42,
				sensitiveOutput: false,
			}),
			artifact(
				"epochs/2/steps/x:research%20offers/1/attempts/2/calls/execute/3.json",
				{
					namespace: "firecrawl",
					method: "firecrawl_agent",
					idempotencyKey: "run-1:research:1:3",
					idempotency: {
						requested: true,
						providerConfirmation: "unknown",
					},
					status: "failed",
					error: { message: "rate limited" },
				},
			),
			artifact(
				"epochs/2/steps/x:research%20offers/1/attempts/2/rollback.json",
				{
					phase: "done",
				},
			),
		]);

		expect(parsed.steps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "research offers",
					executionEpoch: 2,
					kind: "attempt",
					attempt: 1,
					stepId: "step-1",
					status: "succeeded",
					durationMs: 42,
				}),
				expect.objectContaining({
					kind: "rollback",
					attempt: 2,
				}),
			]),
		);
		expect(parsed.toolCalls).toEqual([
			expect.objectContaining({
				name: "research offers",
				attempt: 2,
				ordinal: 3,
				phase: "execute",
				namespace: "firecrawl",
				method: "firecrawl_agent",
				idempotencyKey: "run-1:research:1:3",
				idempotencyRequested: true,
				providerConfirmation: "unknown",
				status: "failed",
				error: { message: "rate limited" },
			}),
		]);
		expect(
			SkillWorkflowStepSchema.safeParse(
				parsed.steps.find((step) => step.kind === "tool_call"),
			).success,
		).toBe(true);
	});

	it("does not label in-flight evidence as successful", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact(
				"epochs/0/steps/x:wait/1/waitForEvent.json",
				{ status: "waiting" },
				{ outcome: "success" },
			),
		]);
		expect(parsed.steps[0]).toMatchObject({
			status: "waiting",
			outcome: "pending",
			executionEpoch: 0,
		});
	});

	it("ignores structured paths without the current x-prefixed step segment", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact("epochs/0/steps/legacy-name/1/attempts/1.json", {
				status: "succeeded",
			}),
		]);

		expect(parsed).toEqual({ steps: [], toolCalls: [] });
	});

	it("ignores timeline events and returns only structured step artifacts", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact("epochs/0/steps/x:interpret/1/attempts/1.json", {
				status: "succeeded",
			}),
			artifact("timeline.json", {
				events: [
					{
						kind: "step.do",
						name: "obsolete-shadow",
						count: 1,
						outcome: "failure",
					},
				],
			}),
		]);

		expect(parsed.steps).toEqual([
			expect.objectContaining({
				path: "epochs/0/steps/x:interpret/1/attempts/1.json",
				provenance: "step_artifact",
				status: "succeeded",
			}),
		]);
	});

	it("aggregates bounded run and step evidence", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact("steps/x:a/1/attempts/1.json", {}, { outcome: "failure" }),
			artifact("steps/x:a/1/attempts/2.json", {}, { attempt: 2 }),
			artifact("epochs/1/steps/x:a/1/attempts/2.json", {}, { attempt: 2 }),
			artifact("steps/x:a/1/rollbacks/1.json", {}),
			artifact("steps/x:a/1/calls/1-attempt-2.json", {}),
		]);
		const result = aggregateSkillWorkflowReliability({
			runs: [
				{
					id: "run-1",
					organizationId: "org-1",
					skillId: "skill-1",
					tediId: "tedi-1",
					workflowInstanceId: "wf-1",
					executionEpoch: 0,
					status: "completed",
					params: { mode: "retry" },
					capabilityManifest: null,
					skillSlug: "skill",
					skillRevision: 1,
					startedAt: "2026-07-11T10:00:00.000Z",
					completedAt: "2026-07-11T10:00:02.000Z",
					pausedAt: null,
					createdBy: null,
					hasResult: true,
					hasError: false,
				},
			],
			steps: parsed.steps,
			skillId: "skill-1",
		});

		expect(result).toMatchObject({
			runCount: 1,
			completedCount: 1,
			successRate: 1,
			averageDurationMs: 2000,
			retryAttemptCount: 2,
			rollbackCount: 1,
			toolCallCount: 1,
			completionRate: 1,
			expectedOutcomes: {
				matchedCount: 1,
				unexpectedCount: 0,
			},
		});
		expect(result.failedSteps).toEqual([{ name: "a", count: 1, failures: 1 }]);
	});

	it("counts pinned intentional failures and cancellations as successful outcomes", () => {
		const reliability = {
			parameter: "mode",
			expectedTerminalStatuses: {
				timeout: "failed" as const,
				rollback: "canceled" as const,
			},
		};
		const run = (
			id: string,
			mode: string,
			status: "completed" | "failed" | "canceled",
		) => ({
			id,
			organizationId: "org-1",
			skillId: "skill-1",
			tediId: "tedi-1",
			workflowInstanceId: `wf-${id}`,
			executionEpoch: 0,
			restartRequestedAt: null,
			workflowRetiredAt: null,
			status,
			params: { mode },
			capabilityManifest: {
				mcp: {},
				network: false,
				rationale: { mode: "important" },
				expectedAnnotations: {},
				reliability,
			},
			skillSlug: "skill",
			skillRevision: 2,
			startedAt: null,
			completedAt: null,
			pausedAt: null,
			createdBy: null,
			hasResult: status === "completed",
			hasError: status === "failed",
		});

		const result = aggregateSkillWorkflowReliability({
			runs: [
				run("run-timeout", "timeout", "failed"),
				run("run-rollback", "rollback", "canceled"),
				run("run-regression", "retry", "failed"),
			],
			steps: [],
		});

		expect(result.completionRate).toBe(0);
		expect(result.successRate).toBe(2 / 3);
		expect(result.expectedOutcomes).toMatchObject({
			evaluatedCount: 3,
			matchedCount: 2,
			unexpectedCount: 1,
			expectedFailedCount: 1,
			expectedCanceledCount: 1,
			unexpectedRuns: [
				{ runId: "run-regression", expected: "completed", actual: "failed" },
			],
		});
	});

	it("computes a restarted run cost summary from the current epoch only", () => {
		const parsed = parseSkillWorkflowRecords([
			artifact("epochs/0/steps/x:publish/1/attempts/1.json", {
				status: "succeeded",
				durationMs: 40,
			}),
			artifact("epochs/0/steps/x:publish/1/attempts/1/calls/run/1.json", {
				namespace: "cms",
				method: "publish",
				status: "succeeded",
			}),
			artifact("epochs/1/steps/x:publish/1/attempts/1.json", {
				status: "succeeded",
				durationMs: 25,
			}),
			artifact("epochs/1/steps/x:publish/1/attempts/1/calls/run/1.json", {
				namespace: "cms",
				method: "publish",
				status: "succeeded",
			}),
		]);

		expect(
			computeSkillRunCostSummary({
				steps: parsed.steps,
				toolCalls: parsed.toolCalls,
				executionEpoch: 1,
				startedAt: "2026-07-12T00:00:00.000Z",
				completedAt: "2026-07-12T00:00:02.000Z",
			}),
		).toEqual({
			schemaVersion: 1,
			steps: 1,
			attempts: 1,
			retries: 0,
			toolCalls: 1,
			toolCallsByNamespace: { cms: 1 },
			stepDurationMs: 25,
			wallMs: 2000,
		});
	});

	it("bounds R2 concurrency, read count, and aggregate inspection content", async () => {
		const artifacts = Array.from({ length: 6 }, (_, index) => ({
			...artifact(`outputs/result-${index}.json`, {}).artifact,
			contentInline: null,
			contentR2Key: `runs/run-1/result-${index}`,
			sizeBytes: 10,
		}));
		let reads = 0;
		let active = 0;
		let maxActive = 0;
		const result = await resolveSkillRunArtifactContents({
			artifacts,
			includeArbitraryContent: true,
			limits: {
				maxAggregateBytes: 20,
				maxArtifactBytes: 15,
				maxR2Reads: 3,
				r2Concurrency: 2,
			},
			loadR2: async () => {
				reads++;
				active++;
				maxActive = Math.max(maxActive, active);
				await Promise.resolve();
				active--;
				return { size: 10, text: async () => "0123456789" };
			},
		});

		expect(reads).toBe(3);
		expect(maxActive).toBeLessThanOrEqual(2);
		expect(result.resolved.filter((item) => item.content != null)).toHaveLength(
			2,
		);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("aggregate inspection budget"),
				expect.stringContaining("R2 artifact body/bodies were omitted"),
			]),
		);
	});

	it("omits an oversized arbitrary inline body but preserves its metadata", async () => {
		const large = artifact("outputs/large.json", "x".repeat(32)).artifact;
		const result = await resolveSkillRunArtifactContents({
			artifacts: [large],
			includeArbitraryContent: true,
			limits: { maxArtifactBytes: 16 },
		});

		expect(result.resolved[0]).toEqual({ artifact: large, content: null });
		expect(result.warnings[0]).toContain("get_skill_run_artifact");
	});
});
