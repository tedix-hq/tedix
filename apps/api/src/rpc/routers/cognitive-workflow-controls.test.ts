import { createRouterClient } from "@orpc/server";
import { SkillRunSummarySchema } from "@tedix/api-contract/contracts/cognitive";
import type { SkillRun } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	createWorkItem: vi.fn(),
	deleteFactsByRunId: vi.fn(),
	deleteRunArtifacts: vi.fn(),
	getOrganizationById: vi.fn(),
	getSkillRun: vi.fn(),
	listWorkItems: vi.fn(),
	listSkillRunsForOrg: vi.fn(),
	listSkillRunsForSkill: vi.fn(),
	listSkillRunsForTedi: vi.fn(),
	listSkillWorkflowRetryCandidateRuns: vi.fn(),
	listRunArtifacts: vi.fn(),
	listRunArtifactsPage: vi.fn(),
	recordTediSubmissionStarted: vi.fn(),
	requestRunAbort: vi.fn(),
	retireSkillRunForRevocation: vi.fn(),
	restartTediSubmissionAttempt: vi.fn(),
	settleTediSubmission: vi.fn(),
	updateWorkItem: vi.fn(),
}));

vi.mock("../../kernel/runtime-submission-bridge", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../kernel/runtime-submission-bridge")
		>();
	return {
		...actual,
		recordTediSubmissionStarted: mocks.recordTediSubmissionStarted,
		requestRunAbort: mocks.requestRunAbort,
		restartTediSubmissionAttempt: mocks.restartTediSubmissionAttempt,
		settleTediSubmission: mocks.settleTediSubmission,
	};
});

vi.mock("@tedix/db/queries/skill-runs", () => ({
	cancelSkillRun: vi.fn(),
	createSkillRun: vi.fn(),
	getSkillRun: mocks.getSkillRun,
	listSkillRunSnapshotsForSkill: vi.fn(),
	listSkillRunsForOrg: mocks.listSkillRunsForOrg,
	listSkillRunsForSkill: mocks.listSkillRunsForSkill,
	listSkillRunsForTedi: mocks.listSkillRunsForTedi,
	listSkillWorkflowRetryCandidateRuns:
		mocks.listSkillWorkflowRetryCandidateRuns,
	retireSkillRunForRevocation: mocks.retireSkillRunForRevocation,
	setSkillRunCostSummary: vi.fn(),
	updateSkillRunStatus: vi.fn(),
}));

vi.mock("@tedix/db/queries/skill-run-artifacts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/skill-run-artifacts")
	>()),
	deleteRunArtifacts: mocks.deleteRunArtifacts,
	listRunArtifacts: mocks.listRunArtifacts,
	listRunArtifactsPage: mocks.listRunArtifactsPage,
}));

vi.mock(
	"@tedix/db/queries/memory-graph/fact-search",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/memory-graph/fact-search")
		>()),
		deleteFactsByRunId: mocks.deleteFactsByRunId,
	}),
);

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	createWorkItem: mocks.createWorkItem,
	listWorkItems: mocks.listWorkItems,
	updateWorkItem: mocks.updateWorkItem,
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));

import {
	isHumanSkillActivator,
	isWorkflowImprovementBaselineTerminal,
	workflowCertificationPassed,
} from "./cognitive-skill-governance";
import { skillsContractRouter } from "./cognitive";

const RUN: SkillRun = {
	id: "run-1",
	organizationId: "org-1",
	skillId: "skill-1",
	tediId: "tedi-1",
	workflowInstanceId: "workflow-1",
	executionEpoch: 7,
	restartRequestedAt: null,
	restartCommandId: null,
	workflowRetiredAt: null,
	runtimeEnvironment: "development",
	lastReconciledAt: null,
	status: "running",
	params: null,
	result: null,
	error: null,
	capabilityManifest: null,
	costSummary: null,
	workflowSource: "export default {}",
	skillDoc: "# Fixture",
	skillRevision: 1,
	skillSlug: "fixture",
	startedAt: "2026-07-12T00:00:00.000Z",
	completedAt: null,
	pausedAt: null,
	createdBy: null,
};

describe("workflow improvement governance", () => {
	it("accepts every terminal run state as improvement evidence", () => {
		expect(isWorkflowImprovementBaselineTerminal("completed")).toBe(true);
		expect(isWorkflowImprovementBaselineTerminal("failed")).toBe(true);
		expect(isWorkflowImprovementBaselineTerminal("canceled")).toBe(true);
		expect(isWorkflowImprovementBaselineTerminal("running")).toBe(false);
		expect(isWorkflowImprovementBaselineTerminal("queued")).toBe(false);
	});

	it("only treats a signed-in user as a human activator", () => {
		expect(
			isHumanSkillActivator({
				authType: "user",
				user: { sub: "user-1" } as never,
			}),
		).toBe(true);
		expect(
			isHumanSkillActivator({
				authType: "service-binding",
				user: undefined,
			}),
		).toBe(false);
		expect(isHumanSkillActivator({ authType: "tedi", user: undefined })).toBe(
			false,
		);
	});

	it("requires an explicit passing correctness envelope", () => {
		expect(
			workflowCertificationPassed({ certification: { status: "passed" } }),
		).toBe(true);
		expect(
			workflowCertificationPassed({ certification: { passed: true } }),
		).toBe(true);
		expect(
			workflowCertificationPassed({
				certification: { overallStatus: "passed" },
			}),
		).toBe(true);
		expect(workflowCertificationPassed({ status: "completed" })).toBe(false);
		expect(
			workflowCertificationPassed({ certification: { passed: false } }),
		).toBe(false);
	});

	it("rejects self-attested certification after a failed workflow tool call", () => {
		expect(
			workflowCertificationPassed(
				{
					certification: {
						passed: true,
						overallStatus: "passed",
					},
				},
				[
					{
						path: "epochs/0/steps/x:synthesize-review/1/attempts/1/calls/run/1.json",
						outcome: "failure",
					},
				],
			),
		).toBe(false);
		expect(
			workflowCertificationPassed({ certification: { passed: true } }, [
				{
					path: "epochs/0/steps/x:gather/1/attempts/1/calls/run/1.json",
					outcome: "success",
				},
				{
					path: "outputs/x:gather.error.json",
					outcome: "failure",
				},
			]),
		).toBe(true);
	});
});

function createContext(
	fetch: ReturnType<typeof vi.fn>,
	waitUntilPromises?: Promise<unknown>[],
): BaseContext {
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: "org-1",
			scopes: ["*"],
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "development",
			SKILL_RUNTIME: { fetch },
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/skills"),
		...(waitUntilPromises
			? {
					waitUntil: (promise: Promise<unknown>) => {
						waitUntilPromises.push(promise);
					},
				}
			: {}),
	};
}

describe("skill workflow control epoch fencing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillRun.mockResolvedValue(RUN);
		mocks.listRunArtifacts.mockResolvedValue([]);
		mocks.listRunArtifactsPage.mockResolvedValue([]);
		mocks.deleteRunArtifacts.mockResolvedValue(0);
		mocks.deleteFactsByRunId.mockResolvedValue(0);
		mocks.retireSkillRunForRevocation.mockResolvedValue(true);
		mocks.requestRunAbort.mockResolvedValue({ requested: true });
	});

	it("sends the D1 execution epoch on every lifecycle control request", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				runId: RUN.id,
				status: "paused",
				executionEpoch: RUN.executionEpoch,
			}),
		);
		const context = createContext(fetch);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.pauseWorkflow({ runId: RUN.id }),
		).resolves.toMatchObject({
			runId: RUN.id,
			status: "paused",
			executionEpoch: RUN.executionEpoch,
		});
		expect(mocks.getSkillRun).toHaveBeenCalledWith(
			context.db,
			RUN.id,
			"org-1",
			"development",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({
			runId: RUN.id,
			workflowInstanceId: RUN.workflowInstanceId,
			expectedExecutionEpoch: RUN.executionEpoch,
		});
	});

	it("projects a runtime epoch mismatch as an actionable API conflict", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "WORKFLOW_EXECUTION_EPOCH_CONFLICT",
						message: "expected epoch 6 but current epoch is 7",
					}),
					{ status: 409 },
				),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.resumeWorkflow({ runId: RUN.id }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"WORKFLOW_EXECUTION_EPOCH_CONFLICT: expected epoch 6 but current epoch is 7",
		});
		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({
			expectedExecutionEpoch: RUN.executionEpoch,
		});
	});

	it("acknowledges a durably recorded cancel as stopping when the runtime is unavailable", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "WORKFLOW_RUNTIME_UNAVAILABLE",
						message: "temporary runtime outage",
					}),
					{ status: 503 },
				),
		);
		const context = createContext(fetch);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.runWorkflowCancel({
				runId: RUN.id,
				confirmDestructive: true,
				reason: "cancel runtime outage fixture",
			}),
		).resolves.toEqual({
			runId: RUN.id,
			status: "running",
			engine: null,
			cancellation: { state: "stopping", durable: true },
		});
		expect(mocks.requestRunAbort).toHaveBeenCalledWith(context.db, {
			runId: RUN.id,
			organizationId: "org-1",
			reason: "skill workflow cancel requested by operator",
		});
		expect(mocks.getSkillRun).toHaveBeenCalledTimes(2);
	});

	it("returns a terminal outcome that wins the race with a failed cancel RPC", async () => {
		const terminalRun: SkillRun = {
			...RUN,
			status: "completed",
			completedAt: "2026-07-12T17:00:00.000Z",
		};
		mocks.getSkillRun
			.mockResolvedValueOnce(RUN)
			.mockResolvedValueOnce(terminalRun);
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "WORKFLOW_RUNTIME_UNAVAILABLE",
						message: "temporary runtime outage",
					}),
					{ status: 503 },
				),
		);
		const context = createContext(fetch);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.runWorkflowCancel({
				runId: RUN.id,
				confirmDestructive: true,
				reason: "cancel terminal race fixture",
			}),
		).resolves.toEqual({ runId: RUN.id, status: "completed", engine: null });
		expect(mocks.settleTediSubmission).toHaveBeenCalledWith(context.db, {
			runId: RUN.id,
			organizationId: "org-1",
			outcome: "settled",
			expectedWorkflowExecutionEpoch: RUN.executionEpoch,
		});
	});

	it("keeps a runtime lifecycle conflict actionable after recording abort intent", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "WORKFLOW_EXECUTION_EPOCH_CONFLICT",
						message: "expected epoch 6 but current epoch is 7",
					}),
					{ status: 409 },
				),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.runWorkflowCancel({
				runId: RUN.id,
				confirmDestructive: true,
				reason: "cancel epoch fixture",
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message:
				"WORKFLOW_EXECUTION_EPOCH_CONFLICT: expected epoch 6 but current epoch is 7",
		});
	});

	it("does not settle an admission marker when runtime status echoes failed", async () => {
		const admissionPendingRun: SkillRun = {
			...RUN,
			status: "failed",
			error: "WORKFLOW_ADMISSION_PENDING: workflow create not yet observed",
			costSummary: {
				schemaVersion: 1,
				steps: 0,
				attempts: 0,
				retries: 0,
				toolCalls: 0,
				toolCallsByNamespace: {},
				stepDurationMs: 0,
				wallMs: null,
			},
		};
		mocks.getSkillRun.mockResolvedValue(admissionPendingRun);
		const fetch = vi.fn(async () =>
			Response.json({
				status: "failed",
				error: admissionPendingRun.error,
				executionEpoch: admissionPendingRun.executionEpoch,
				engine: { status: "errored" },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.runWorkflowStatus({ runId: admissionPendingRun.id }),
		).resolves.toMatchObject({
			id: admissionPendingRun.id,
			status: "failed",
			error: admissionPendingRun.error,
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(mocks.settleTediSubmission).not.toHaveBeenCalled();
		expect(mocks.recordTediSubmissionStarted).not.toHaveBeenCalled();
		expect(mocks.restartTediSubmissionAttempt).not.toHaveBeenCalled();
	});

	it("never re-exposes result, cost, or engine output for a retired run", async () => {
		const retiredRun: SkillRun = {
			...RUN,
			status: "completed",
			workflowRetiredAt: "2026-07-12T00:02:00.000Z",
			error: "REVOKED: privacy cleanup",
			result: { secret: "must not survive revoke" },
			costSummary: {
				schemaVersion: 1,
				steps: 1,
				attempts: 1,
				retries: 0,
				toolCalls: 1,
				toolCallsByNamespace: { source: 1 },
				stepDurationMs: 12,
				wallMs: 20,
			},
		};
		mocks.getSkillRun.mockResolvedValue(retiredRun);
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				result: retiredRun.result,
				engine: { status: "complete", output: retiredRun.result },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.runWorkflowStatus({ runId: retiredRun.id }),
		).resolves.toMatchObject({
			id: retiredRun.id,
			status: "completed",
			result: null,
			costSummary: null,
			engine: null,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.settleTediSubmission).not.toHaveBeenCalled();
	});
});

describe("skill workflow inspection reconciliation", () => {
	it("returns the engine-reconciled run instead of a stale stored status", async () => {
		const completed = {
			...RUN,
			status: "completed" as const,
			result: { certification: { status: "passed" } },
			completedAt: "2026-07-12T00:00:03.000Z",
		};
		mocks.getSkillRun
			.mockResolvedValueOnce(RUN)
			.mockResolvedValueOnce(completed)
			.mockResolvedValue(completed);
		mocks.listRunArtifacts.mockResolvedValue([]);
		const fetch = vi.fn(async () =>
			Response.json({
				runId: RUN.id,
				status: "completed",
				result: completed.result,
				completedAt: completed.completedAt,
				executionEpoch: RUN.executionEpoch,
				engine: { status: "complete" },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		const inspection = await client.inspectWorkflowRun({ runId: RUN.id });

		expect(inspection.run).toMatchObject({
			status: "completed",
			result: completed.result,
			engine: { status: "complete" },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("skill run failure alert work item", () => {
	// Dedup key is per (skill, error-class), not per run — "step" is the first
	// alpha token of the error preview below (no `*Error` type name present).
	const FAILED_SOURCE_INTENT_ID = `skill-run-failed:${RUN.skillId}:step`;

	function failedStatusFetch() {
		return vi.fn(async () =>
			Response.json({
				status: "failed",
				error: "step 3 exploded: upstream 500",
				executionEpoch: RUN.executionEpoch,
				completedAt: "2026-07-12T03:00:00.000Z",
				engine: { status: "errored" },
			}),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillRun.mockResolvedValue(RUN);
		mocks.createWorkItem.mockResolvedValue({ id: "wi-alert-1" });
		mocks.listWorkItems.mockResolvedValue({ data: [], total: 0 });
		mocks.updateWorkItem.mockResolvedValue(undefined);
		mocks.getOrganizationById.mockResolvedValue({
			id: "org-1",
			slug: "acme",
		});
	});

	it("creates a high-priority incident work item on the first observed failed transition", async () => {
		const waitUntilPromises: Promise<unknown>[] = [];
		const context = createContext(failedStatusFetch(), waitUntilPromises);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.runWorkflowStatus({ runId: RUN.id }),
		).resolves.toMatchObject({
			id: RUN.id,
		});
		await Promise.allSettled(waitUntilPromises);

		// Dedup is the createWorkItem (orgId, sourceIntentId) upsert, not a
		// read-then-write pre-check.
		expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
		const [, params] = mocks.createWorkItem.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(params).toMatchObject({
			orgId: "org-1",
			title: "Skill run failed: fixture (step)",
			workKind: "incident",
			priority: "high",
			accountableOwnerType: "tedi",
			accountableOwnerId: RUN.tediId,
			// Purpose gate: an unattended skill-run failure is an operational
			// incident with a bounded (7d) purpose exception, not objective work.
			workClass: "incident",
			purposeExceptionExpiresAt: "2026-07-19T03:00:00.000Z",
			sourceIntentId: FAILED_SOURCE_INTENT_ID,
			createdAt: "2026-07-12T03:00:00.000Z",
			metadata: expect.objectContaining({
				skillRunId: RUN.id,
				skillId: RUN.skillId,
				errorClass: "step",
				errorPreview: "step 3 exploded: upstream 500",
				lastRunId: RUN.id,
				lastFailedAt: "2026-07-12T03:00:00.000Z",
				runUrl: "https://acme.os.tedix.tech/activity/runs/run-1",
			}),
		});
		expect(String(params.description)).toContain(RUN.id);
		expect(String(params.description)).toContain(
			"step 3 exploded: upstream 500",
		);
		expect(String(params.description)).toContain(
			"https://acme.os.tedix.tech/activity/runs/run-1",
		);
	});

	it("converges a second reconcile of the same failed run on the same upsert key", async () => {
		const waitUntilPromises: Promise<unknown>[] = [];
		const context = createContext(failedStatusFetch(), waitUntilPromises);
		const client = createRouterClient(skillsContractRouter, { context });

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);
		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		// Each observation re-runs the upsert (refreshing metadata), but both
		// carry the same deterministic sourceIntentId — one row, no duplicates.
		expect(mocks.createWorkItem).toHaveBeenCalledTimes(2);
		const intentIds = mocks.createWorkItem.mock.calls.map(
			([, params]) => (params as Record<string, unknown>).sourceIntentId,
		);
		expect(intentIds).toEqual([
			FAILED_SOURCE_INTENT_ID,
			FAILED_SOURCE_INTENT_ID,
		]);
	});

	it("uses the durable error when a later observation omits its preview", async () => {
		const waitUntilPromises: Promise<unknown>[] = [];
		mocks.getSkillRun.mockResolvedValue({
			...RUN,
			status: "failed",
			error: "NetworkError: runtime unavailable",
		});
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					status: "failed",
					error: "NetworkError: runtime unavailable",
					executionEpoch: RUN.executionEpoch,
					completedAt: "2026-07-12T03:00:00.000Z",
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "failed",
					executionEpoch: RUN.executionEpoch,
					completedAt: "2026-07-12T03:00:00.000Z",
				}),
			);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);
		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(
			mocks.createWorkItem.mock.calls.map(
				([, params]) => (params as Record<string, unknown>).sourceIntentId,
			),
		).toEqual([
			`skill-run-failed:${RUN.skillId}:networkerror`,
			`skill-run-failed:${RUN.skillId}:networkerror`,
		]);
	});

	it("keeps different failure classes and refusals distinct", async () => {
		const waitUntilPromises: Promise<unknown>[] = [];
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					status: "failed",
					error: "NetworkError: unavailable",
					executionEpoch: RUN.executionEpoch,
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "failed",
					error: "ValidationError: invalid input",
					executionEpoch: RUN.executionEpoch,
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					status: "failed",
					error: "NonRetryableError: request refused by policy",
					executionEpoch: RUN.executionEpoch,
				}),
			);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);
		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);
		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(
			mocks.createWorkItem.mock.calls.map(
				([, params]) => (params as Record<string, unknown>).sourceIntentId,
			),
		).toEqual([
			`skill-run-failed:${RUN.skillId}:networkerror`,
			`skill-run-failed:${RUN.skillId}:validationerror`,
			`skill-run-failed:${RUN.skillId}:refusal`,
		]);
	});

	it("classifies a connection-refused crash as its error type, not a refusal", async () => {
		// Prose matching would file `connect ECONNREFUSED ... connection refused`
		// as a deliberate refusal; the runtime signals refusal with the thrown
		// type (`NonRetryableError`), so a network crash keeps its own class.
		const waitUntilPromises: Promise<unknown>[] = [];
		const fetch = vi.fn().mockResolvedValueOnce(
			Response.json({
				status: "failed",
				error:
					"FetchError: request to https://example.test failed, reason: connect ECONNREFUSED 10.0.0.1:443 connection refused",
				executionEpoch: RUN.executionEpoch,
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(
			mocks.createWorkItem.mock.calls.map(
				([, params]) => (params as Record<string, unknown>).sourceIntentId,
			),
		).toEqual([`skill-run-failed:${RUN.skillId}:fetcherror`]);
	});

	it("creates the alert when D1 already contains the runtime's failed status", async () => {
		const alreadyFailed = {
			...RUN,
			status: "failed" as const,
			error: "step 3 exploded: upstream 500",
			completedAt: "2026-07-12T03:00:00.000Z",
		};
		mocks.getSkillRun.mockResolvedValue(alreadyFailed);
		const context = createContext(failedStatusFetch());
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.runWorkflowStatus({ runId: RUN.id }),
		).resolves.toMatchObject({
			status: "failed",
		});

		expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
		const [, params] = mocks.createWorkItem.mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(params).toMatchObject({
			orgId: "org-1",
			sourceIntentId: FAILED_SOURCE_INTENT_ID,
			workClass: "incident",
		});
	});

	it("never alerts for conformance fixtures that fail on purpose", async () => {
		mocks.getSkillRun.mockResolvedValue({
			...RUN,
			skillSlug: "workflow-kitchen-sink",
		});
		const waitUntilPromises: Promise<unknown>[] = [];
		const context = createContext(failedStatusFetch(), waitUntilPromises);
		const client = createRouterClient(skillsContractRouter, { context });

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(mocks.createWorkItem).not.toHaveBeenCalled();
	});

	it("keeps reconciliation green when the work-item write fails", async () => {
		mocks.createWorkItem.mockRejectedValue(new Error("d1 unavailable"));
		const waitUntilPromises: Promise<unknown>[] = [];
		const context = createContext(failedStatusFetch(), waitUntilPromises);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.runWorkflowStatus({ runId: RUN.id }),
		).resolves.toMatchObject({
			id: RUN.id,
		});
		const settled = await Promise.allSettled(waitUntilPromises);
		// The alert promise is caught at the emit site — nothing may reject.
		expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
		expect(mocks.createWorkItem).toHaveBeenCalledTimes(1);
	});

	it("creates nothing for a completed transition", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				completedAt: "2026-07-12T03:00:00.000Z",
				engine: { status: "complete" },
			}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const context = createContext(fetch, waitUntilPromises);
		const client = createRouterClient(skillsContractRouter, { context });

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(mocks.createWorkItem).not.toHaveBeenCalled();
		expect(mocks.listWorkItems).not.toHaveBeenCalled();
		expect(mocks.updateWorkItem).not.toHaveBeenCalled();
	});

	it("does not complete an alert without accepted evidence after a later successful run", async () => {
		mocks.listWorkItems.mockResolvedValue({
			data: [
				{
					id: "wi-alert-1",
					status: "todo",
					ownerType: "system",
					ownerId: "skills",
					updatedAt: "2026-07-12T03:00:00.000Z",
					provenance: { source: "skills.reconcile.skillRunFailed" },
					metadata: {
						lastFailedAt: "2026-07-12T03:00:00.000Z",
						errorClass: "step",
					},
				},
			],
			total: 1,
		});
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				completedAt: "2026-07-13T03:00:00.000Z",
				engine: { status: "complete" },
			}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(mocks.updateWorkItem).not.toHaveBeenCalled();
	});

	it("does not cancel an alert refreshed by a same-time or newer failure", async () => {
		mocks.listWorkItems.mockResolvedValue({
			data: [
				{
					id: "wi-alert-1",
					status: "todo",
					ownerType: "system",
					ownerId: "skills",
					updatedAt: "2026-07-14T03:00:00.000Z",
					provenance: { source: "skills.reconcile.skillRunFailed" },
					metadata: { lastFailedAt: "2026-07-14T03:00:00.000Z" },
				},
			],
			total: 1,
		});
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				completedAt: "2026-07-13T03:00:00.000Z",
				engine: { status: "complete" },
			}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(mocks.updateWorkItem).not.toHaveBeenCalled();
	});

	it("does not infer recovery time from when an old success is inspected", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				engine: { status: "complete" },
			}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await client.runWorkflowStatus({ runId: RUN.id });
		await Promise.allSettled(waitUntilPromises);

		expect(mocks.listWorkItems).not.toHaveBeenCalled();
		expect(mocks.updateWorkItem).not.toHaveBeenCalled();
	});

	it("keeps successful reconciliation green when recovery settlement fails", async () => {
		mocks.listWorkItems.mockRejectedValue(new Error("d1 unavailable"));
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				completedAt: "2026-07-13T03:00:00.000Z",
				engine: { status: "complete" },
			}),
		);
		const waitUntilPromises: Promise<unknown>[] = [];
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch, waitUntilPromises),
		});

		await expect(
			client.runWorkflowStatus({ runId: RUN.id }),
		).resolves.toMatchObject({
			id: RUN.id,
		});
		const settled = await Promise.allSettled(waitUntilPromises);
		expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
	});
});

describe("skill workflow history repair", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.listRunArtifacts.mockResolvedValue([]);
	});

	it("passes an exact skill tag to the tedi-scoped history query", async () => {
		mocks.listSkillRunsForTedi.mockResolvedValue([]);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(),
		});

		await expect(
			client.runWorkflowHistory({
				tediId: RUN.tediId,
				skillTag: "flow-ephemeral",
				limit: 15,
			}),
		).resolves.toEqual({ runs: [] });
		expect(mocks.listSkillRunsForTedi).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			RUN.tediId,
			"development",
			{
				limit: 15,
				status: undefined,
				skillId: undefined,
				skillTag: "flow-ephemeral",
			},
		);
	});

	it("reconciles a terminal-looking row with an open restart intent", async () => {
		const restartRequestedAt = "2026-07-12T00:03:00.000Z";
		const stale = {
			id: RUN.id,
			organizationId: RUN.organizationId,
			skillId: RUN.skillId,
			tediId: RUN.tediId,
			workflowInstanceId: RUN.workflowInstanceId,
			runtimeEnvironment: RUN.runtimeEnvironment,
			lastReconciledAt: RUN.lastReconciledAt,
			executionEpoch: RUN.executionEpoch,
			restartRequestedAt,
			workflowRetiredAt: null,
			status: "completed" as const,
			skillSlug: RUN.skillSlug,
			skillRevision: RUN.skillRevision,
			startedAt: RUN.startedAt,
			completedAt: "2026-07-12T00:02:00.000Z",
			pausedAt: null,
			createdBy: null,
			hasResult: true,
			hasError: false,
		};
		const staleFull: SkillRun = {
			...RUN,
			status: "completed",
			restartRequestedAt,
			restartCommandId: "restart-8",
			result: { stale: true },
			completedAt: stale.completedAt,
		};
		const repaired: SkillRun = {
			...RUN,
			executionEpoch: 8,
			status: "queued",
			restartRequestedAt: null,
			restartCommandId: null,
			result: null,
			completedAt: null,
		};
		mocks.listSkillRunsForOrg.mockResolvedValue([stale]);
		mocks.getSkillRun
			.mockResolvedValueOnce(staleFull)
			.mockResolvedValueOnce(repaired);
		const fetch = vi.fn(async () =>
			Response.json({
				status: "queued",
				executionEpoch: 8,
				restartId: "restart-8",
				engine: { status: "queued" },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(client.runWorkflowHistory({})).resolves.toEqual({
			runs: [
				expect.objectContaining({
					id: RUN.id,
					executionEpoch: 8,
					status: "queued",
					restartRequestedAt: null,
					completedAt: null,
					hasResult: false,
				}),
			],
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(mocks.restartTediSubmissionAttempt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ restartId: "restart-8", executionEpoch: 8 }),
		);
	});

	it("returns only validated SkillRunSummary contract keys", async () => {
		// Regression: skillRunSummarySelect gained params + capabilityManifest
		// for the reliability expected-outcome policy (internal consumers). The
		// MCP edge validates structuredContent with additionalProperties:false,
		// so any extra key on a run row fails the entire aggregate history call.
		// Keep runtime output validation on this transforming endpoint so source
		// and contract drift fails here before it reaches MCP.
		const summaryRow = {
			id: RUN.id,
			organizationId: RUN.organizationId,
			skillId: RUN.skillId,
			tediId: RUN.tediId,
			workflowInstanceId: RUN.workflowInstanceId,
			runtimeEnvironment: "production" as const,
			lastReconciledAt: "2026-07-25T05:58:00.000Z",
			executionEpoch: RUN.executionEpoch,
			restartRequestedAt: null,
			workflowRetiredAt: null,
			status: "completed" as const,
			// Representative production row: both internal-only columns populated.
			params: { asin: "B0TEST", marketplace: "acme" },
			capabilityManifest: { reliability: { parameter: "mode" } },
			skillSlug: RUN.skillSlug,
			skillRevision: RUN.skillRevision,
			startedAt: RUN.startedAt,
			completedAt: "2026-07-12T00:02:00.000Z",
			pausedAt: null,
			createdBy: "schedule",
			hasResult: 1,
			hasError: 0,
		};
		mocks.listSkillRunsForSkill.mockResolvedValue([summaryRow]);
		const fetch = vi.fn(async () => {
			throw new Error("terminal rows must not trigger reconcile");
		});
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		const response = await client.runWorkflowHistory({ skillId: RUN.skillId });
		expect(response.runs).toHaveLength(1);
		const allowedKeys = new Set(Object.keys(SkillRunSummarySchema.shape));
		for (const run of response.runs) {
			const extraKeys = Object.keys(run).filter((key) => !allowedKeys.has(key));
			expect(extraKeys).toEqual([]);
		}
		expect(response.runs[0]).toMatchObject({
			id: RUN.id,
			status: "completed",
			runtimeEnvironment: "production",
			lastReconciledAt: "2026-07-25T05:58:00.000Z",
			hasResult: true,
			hasError: false,
		});
	});
});

describe("skill workflow retry candidates", () => {
	it("returns the current failed run with an epoch-bound restart identity", async () => {
		const failed = {
			...RUN,
			status: "failed" as const,
			error: "boom",
			completedAt: "2026-07-12T00:02:00.000Z",
		};
		mocks.listSkillWorkflowRetryCandidateRuns.mockResolvedValue([
			{
				...failed,
				hasResult: 0,
				hasError: 1,
				outcome: null,
				workItemId: null,
			},
		]);
		mocks.getSkillRun.mockResolvedValue(failed);
		const fetch = vi.fn(async () =>
			Response.json({
				status: "failed",
				executionEpoch: RUN.executionEpoch,
				completedAt: failed.completedAt,
				engine: { status: "failed" },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.listWorkflowRetryCandidates({ limit: 50 }),
		).resolves.toEqual({
			candidates: [
				{
					runId: RUN.id,
					tediId: RUN.tediId,
					skillId: RUN.skillId,
					skillSlug: RUN.skillSlug,
					status: "failed",
					executionEpoch: RUN.executionEpoch,
					restartId: `activity:${RUN.id}:${RUN.executionEpoch}`,
					failedAt: failed.completedAt,
					error: "boom",
				},
			],
		});
		expect(mocks.listSkillWorkflowRetryCandidateRuns).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			"development",
			50,
		);
	});
});

describe("skill workflow revoke retirement fence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getSkillRun.mockResolvedValue({ ...RUN, status: "completed" });
		mocks.listRunArtifacts.mockResolvedValue([]);
		mocks.deleteRunArtifacts.mockResolvedValue(0);
		mocks.deleteFactsByRunId.mockResolvedValue(0);
		mocks.retireSkillRunForRevocation.mockResolvedValue(true);
	});

	it.each([
		["active", { ...RUN, status: "running" as const }],
		[
			"admission-ambiguous",
			{
				...RUN,
				status: "failed" as const,
				error: "WORKFLOW_ADMISSION_PENDING: create result unknown",
			},
		],
		[
			"restart-ambiguous",
			{
				...RUN,
				status: "completed" as const,
				restartRequestedAt: "2026-07-12T00:01:00.000Z",
				restartCommandId: "restart-1",
			},
		],
	])("rejects %s rows before any destructive work", async (_name, run) => {
		mocks.getSkillRun.mockResolvedValue(run);
		const fetch = vi.fn();
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: run.id, reason: "cleanup" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.retireSkillRunForRevocation).not.toHaveBeenCalled();
		expect(mocks.deleteRunArtifacts).not.toHaveBeenCalled();
		expect(mocks.deleteFactsByRunId).not.toHaveBeenCalled();
	});

	it("requires a raw terminal Cloudflare engine snapshot", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				engine: { status: "running" },
			}),
		);
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: RUN.id, reason: "cleanup" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("WORKFLOW_ENGINE_NOT_TERMINAL"),
		});
		expect(mocks.retireSkillRunForRevocation).not.toHaveBeenCalled();
		expect(mocks.deleteRunArtifacts).not.toHaveBeenCalled();
	});

	it("retires a terminal run before deleting any sourced state", async () => {
		const order: string[] = [];
		mocks.retireSkillRunForRevocation.mockImplementation(async () => {
			order.push("retire");
			return true;
		});
		mocks.deleteRunArtifacts.mockImplementation(async () => {
			order.push("delete-artifacts");
			return 2;
		});
		mocks.deleteFactsByRunId.mockImplementation(async () => {
			order.push("delete-facts");
			return 3;
		});
		const fetch = vi.fn(async () =>
			Response.json({
				status: "completed",
				executionEpoch: RUN.executionEpoch,
				engine: { status: "complete" },
			}),
		);
		const context = createContext(fetch);
		const client = createRouterClient(skillsContractRouter, { context });

		await expect(
			client.revokeSkillRun({ runId: RUN.id, reason: "cleanup" }),
		).resolves.toMatchObject({
			revoked: true,
			artifactsDeleted: 2,
			factsDeleted: 3,
		});
		expect(order).toEqual(["retire", "delete-artifacts", "delete-facts"]);
		expect(mocks.retireSkillRunForRevocation).toHaveBeenCalledWith(context.db, {
			runId: RUN.id,
			organizationId: "org-1",
			runtimeEnvironment: "development",
			expectedExecutionEpoch: RUN.executionEpoch,
			reason: "cleanup",
		});
	});

	it("allows a terminal operator-aborted instance to be revoked", async () => {
		mocks.getSkillRun.mockResolvedValue({
			...RUN,
			status: "canceled",
			workflowRetiredAt: "2026-07-12T00:01:00.000Z",
		});
		const fetch = vi.fn();
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: RUN.id, reason: "cleanup" }),
		).resolves.toMatchObject({ revoked: true });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.retireSkillRunForRevocation).toHaveBeenCalledOnce();
		expect(mocks.deleteRunArtifacts).toHaveBeenCalledOnce();
	});

	it("repairs partial cleanup after a durable revoke claim", async () => {
		const claimed = {
			...RUN,
			status: "completed" as const,
			error: "REVOKED: cleanup",
			workflowRetiredAt: "2026-07-12T00:01:00.000Z",
		};
		mocks.getSkillRun.mockResolvedValue(claimed);
		mocks.retireSkillRunForRevocation.mockResolvedValue(false);
		const fetch = vi.fn();
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: RUN.id, reason: "cleanup" }),
		).resolves.toMatchObject({ revoked: true, reason: "cleanup" });
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.retireSkillRunForRevocation).not.toHaveBeenCalled();
		expect(mocks.deleteRunArtifacts).toHaveBeenCalledOnce();
		expect(mocks.deleteFactsByRunId).toHaveBeenCalledOnce();
	});

	it("refuses to rewrite the audit reason on a claimed cleanup retry", async () => {
		const claimed = {
			...RUN,
			status: "completed" as const,
			error: "REVOKED: original reason",
			workflowRetiredAt: "2026-07-12T00:01:00.000Z",
		};
		mocks.getSkillRun.mockResolvedValue(claimed);
		mocks.retireSkillRunForRevocation.mockResolvedValue(false);
		const fetch = vi.fn();
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: RUN.id, reason: "different reason" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("different audit reason"),
		});
		expect(mocks.deleteRunArtifacts).not.toHaveBeenCalled();
		expect(mocks.deleteFactsByRunId).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps legacy REVOKED rows as a no-op", async () => {
		mocks.getSkillRun.mockResolvedValue({
			...RUN,
			status: "running",
			error: "REVOKED",
			workflowRetiredAt: null,
		});
		const fetch = vi.fn();
		const client = createRouterClient(skillsContractRouter, {
			context: createContext(fetch),
		});

		await expect(
			client.revokeSkillRun({ runId: RUN.id }),
		).resolves.toMatchObject({
			revoked: true,
			artifactsDeleted: 0,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.retireSkillRunForRevocation).not.toHaveBeenCalled();
	});
});
