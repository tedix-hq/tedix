import { createRouterClient } from "@orpc/server";
import * as skillCrudQueries from "@tedix/db/queries/cognitive/skill-crud";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { SKILL_REFERENCE_VERB } from "@tedix/api-contract/utils/skill-reference";
import { resolveKernelWorkstationAttachWorkOrder } from "./kernel-runtime/control-proposals";
import { respondKernelDelegationRecommendationApprovalCore } from "./kernel-runtime/approval-control";
import { predictAgentRunId } from "./kernel/runtime-shared";
import {
	detectOperatorSlashCommand,
	kernelRuntimeTestHooks,
} from "./kernel-runtime/policy-normalization";
import { kernelRuntimeContractRouter } from "./kernel-runtime";
import {
	proposeCodemodeExecuteImpl,
	proposeRepoCommitImpl,
} from "./kernel-runtime/control-proposals";
import { settleHomeToolWriteApproval } from "./kernel/write-approval-settlement";

import {
	ORG_ID,
	childRuntimeEvent,
	NATIVE_EXECUTION_REQUIREMENT,
	type WorkItemRow,
	type WorkAttemptRow,
	normalizeKernelConversationInsert,
	normalizeKernelRuntimeEventInsert,
	normalizeKernelRuntimeRunInsert,
	normalizeWorkItemInsert,
	runningWorkAttempt,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
} from "./__tests__/kernel-runtime-db";

function recordOriginalChildStop(
	db: ReturnType<typeof createKernelRuntimeDb>,
	runId: string,
) {
	const run = db.runs.find((row) => row.id === runId)!;
	run.childRunId ??= `child-${runId}`;
	db.runtimeEvents.push(
		childRuntimeEvent({
			id: `terminal-${runId}`,
			createdAt: "2026-06-20T08:01:00.000Z",
			kind: "run.failed",
			runId: run.childRunId,
			tediId: run.delegatedTediId!,
			payload: { status: "failed" },
		}),
	);
}

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			expiresAt: new Date(
				Date.parse(input.now) + input.leaseTtlMs,
			).toISOString(),
			decision: "admitted" as const,
		})),
	};
});

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/attempts")
		>();
	return {
		...original,
		startWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					admissionId: string;
					executor: { type: "tedi" | "external_agent"; id: string };
					expiresAt?: string;
					metadata?: Record<string, unknown>;
					orgId: string;
					runId?: string;
					startedAt?: string;
					workItemId: string;
				},
			) => {
				const fake = db as {
					workAttemptRows: WorkAttemptRow[];
					workItemRows: WorkItemRow[];
				};
				const workItem = fake.workItemRows.find(
					(row) => row.id === input.workItemId,
				);
				if (!workItem) throw new Error(`Missing Work Item ${input.workItemId}`);
				const startedAt = input.startedAt ?? new Date().toISOString();
				const attempt = {
					id: crypto.randomUUID(),
					admissionId: input.admissionId,
					workItemId: input.workItemId,
					orgId: input.orgId,
					executorType: input.executor.type,
					executorId: input.executor.id,
					executorSessionId: null,
					externalSessionKey: null,
					runId: input.runId ?? null,
					runtimeState: "running",
					outcome: null,
					attemptNumber: fake.workAttemptRows.length + 1,
					startedAt,
					heartbeatAt: startedAt,
					expiresAt: input.expiresAt ?? null,
					finishedAt: null,
					summary: null,
					version: 1,
					metadata: input.metadata ?? {},
				} as WorkAttemptRow;
				fake.workAttemptRows.push(attempt);
				return { workItem, attempt, resumed: false };
			},
		),
		settleWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					attemptId: string;
					outcome: "succeeded" | "failed" | "cancelled";
					settledAt?: string;
					summary?: string;
				},
			) => {
				const fake = db as { workAttemptRows: WorkAttemptRow[] };
				const attempt = fake.workAttemptRows.find(
					(row) => row.id === input.attemptId,
				);
				if (!attempt)
					throw new Error(`Missing Work attempt ${input.attemptId}`);
				attempt.outcome = input.outcome;
				attempt.runtimeState =
					input.outcome === "succeeded"
						? "finished"
						: input.outcome === "failed"
							? "failed"
							: "cancelled";
				attempt.finishedAt = input.settledAt ?? new Date().toISOString();
				attempt.summary = input.summary ?? null;
				attempt.version += 1;
				return attempt;
			},
		),
	};
});

vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	submitWorkItemEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as { workEvidenceRows: Array<Record<string, any>> };
			const evidence = {
				id: crypto.randomUUID(),
				attemptId: input.attemptId ?? null,
				claimKey: input.claimKey,
				digest: input.digest ?? null,
				disposition: "pending",
				kind: input.kind,
				metadata: input.metadata ?? {},
				uri: input.uri,
				workItemId: input.workItemId,
			};
			fake.workEvidenceRows.push(evidence);
			return evidence;
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/projections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/projections")
	>()),
	listOrgWorkEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as {
				workEvidenceRows: Array<Record<string, any>>;
				workItemRows: WorkItemRow[];
			};
			return {
				data: fake.workEvidenceRows
					.filter(
						(row) =>
							row.workItemId === input.workItemId &&
							row.attemptId === input.attemptId,
					)
					.map((evidence) => ({
						evidence,
						workItem: fake.workItemRows.find(
							(item) => item.id === evidence.workItemId,
						),
					})),
				nextCursor: null,
				observedAt: new Date().toISOString(),
			};
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	completeWorkItem: vi.fn(async (db: unknown, input: Record<string, any>) => {
		const fake = db as { workItemRows: WorkItemRow[] };
		const item = fake.workItemRows.find((row) => row.id === input.workItemId);
		if (!item) throw new Error(`Missing Work Item ${input.workItemId}`);
		item.disposition = "completed";
		return item;
	}),
}));

describe("enqueueMessage routing composition (needs × capability)", () => {
	it.each([
		{ delegateToTediId: "tedi-cto-agent" },
		{ executionPolicy: "observe_only" as const },
	])(
		"members cannot force dispatch or override execution policy: %j",
		async (input) => {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient({
				...createContext(db, { userSub: "member-1" }),
				authType: "user",
				apiKey: undefined,
				userRole: "member",
			});
			const runner = vi.fn();
			kernelRuntimeTestHooks.setDelegateRunnerForTest(runner);
			await expect(
				client.enqueueMessage({
					conversationId: "home:test",
					content: "Research",
					...input,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(runner).not.toHaveBeenCalled();
			expect(db.approvals).toHaveLength(0);
		},
	);

	it("(a) capable target + no signal → native isolate (workstationAttach false)", async () => {
		// tedi-cto-agent has repoConfig.repoUrl → workstation-capable. No
		// needsEmbodiedSurface in metadata → native isolate delegation (no approval).
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient({
			...createContext(db, { userSub: "admin-1" }),
			authType: "user",
			apiKey: undefined,
			userRole: "admin",
		});
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; content: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Summarise the git log",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-a",
		});

		// Native path → delegate runner fires; no approval gate.
		expect(delegateRunner).toHaveBeenCalled();
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			metadata: { executionSurface: "native" },
		});
		expect(result).toMatchObject({
			status: "queued",
			run: {
				delegatedTediId: "tedi-cto-agent",
				status: "queued",
			},
		});
		expect(db.approvals).toHaveLength(0);
		db.tediRows.find((row) => row.id === "tedi-cto-agent")!.organizationId =
			"foreign-org";
		await expect(
			client.enqueueMessage({
				conversationId: "home:test",
				content: "Do not dispatch",
				delegateToTediId: "tedi-cto-agent",
				idempotencyKey: "comp-test-a-denied",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(delegateRunner).toHaveBeenCalledTimes(1);
	});

	it("reuses an existing Work Item for native delegation without creating a wrapper", async () => {
		const db = createKernelRuntimeDb();
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Existing graph lens task",
				disposition: "accepted",
				workKind: "coding",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto-agent",
				priority: "medium",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				metadata: { existingCanonicalItem: true },
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn(
			async (input: {
				childRunId: string;
				content: string;
				metadata: Record<string, unknown>;
			}) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Implement the remaining graph lens",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-existing-native",
			metadata: { workItemId },
		});

		expect(db.workItemRows).toHaveLength(1);
		expect(db.workItemRows[0]).toMatchObject({
			id: workItemId,
			accountableOwnerId: "tedi-cto-agent",
			disposition: "accepted",
			metadata: {
				existingCanonicalItem: true,
			},
		});
		expect(db.workAttemptRows).toHaveLength(1);
		expect(db.workAttemptRows[0]).toMatchObject({
			workItemId,
			executorId: "tedi-cto-agent",
		});
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		expect(delegateRunner.mock.calls[0]?.[0]).toMatchObject({
			metadata: { workItemId, executionSurface: "native" },
		});
		expect(delegateRunner.mock.calls[0]?.[0].content).toContain(
			`Work Item: ${workItemId}`,
		);
		expect(result.run.metadata).toMatchObject({ workItemId });
	});

	it("fails closed when the requested canonical Work Item belongs to another tedi", async () => {
		const db = createKernelRuntimeDb();
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Already assigned task",
				disposition: "accepted",
				workKind: "coding",
				priority: "medium",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cpo",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const delegateRunner = vi.fn();
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		await expect(
			client.enqueueMessage({
				conversationId: "home:test",
				content: "Take somebody else's item",
				delegateToTediId: "tedi-cto-agent",
				idempotencyKey: "comp-test-existing-conflict",
				metadata: { workItemId },
			}),
		).rejects.toThrow(`Work Item ${workItemId} is unavailable`);
		expect(db.workItemRows).toHaveLength(1);
		expect(db.workAttemptRows).toHaveLength(0);
		expect(delegateRunner).not.toHaveBeenCalled();
	});

	it("(b) capable target + needsEmbodiedSurface:true → workstation (workstationAttach true)", async () => {
		// Same workstation-capable tedi; metadata carries needsEmbodiedSurface:true
		// → WORKSTATION-attach work order (requires_approval before dispatch).
		const db = createKernelRuntimeDb();
		const context = createContext(db) as BaseContext & {
			waitUntilPromises: Promise<unknown>[];
		};
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Existing workstation coding task",
				disposition: "accepted",
				workKind: "coding",
				accountableOwnerType: "tedi",
				accountableOwnerId: "tedi-cto-agent",
				priority: "medium",
				workClass: "maintenance",
				// Mock-db data only: createKernelRuntimeDb does not evaluate the
				// activePurposeContext expiry filter (probed with a past date), so
				// this literal never meets the wall clock. Not a time bomb.
				purposeExceptionExpiresAt: "2026-08-01T00:00:00.000Z",
				metadata: {
					existingCanonicalItem: true,
					executionRequirement: {
						surface: "workstation",
						requiredCapabilities: [
							"repository_read",
							"repository_edit",
							"tests",
						],
						fallbackSurface: null,
						prohibitedSurfaces: ["native", "managed_job"],
						satisfiable: true,
						reason: "canonical repository Work Item requirement",
					},
				},
				createdAt: "2026-07-21T00:00:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(context);
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; content: string }) => ({
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		const result = await client.enqueueMessage({
			conversationId: "home:test",
			content: "Write and run a migration script in the repo",
			delegateToTediId: "tedi-cto-agent",
			idempotencyKey: "comp-test-b",
			metadata: { needsEmbodiedSurface: true, workItemId },
		});
		await Promise.all(context.waitUntilPromises);

		// Workstation path → approval gate before dispatch; runner not called yet.
		expect(delegateRunner).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "requires_approval",
			run: {
				status: "requires_approval",
				delegatedTediId: "tedi-cto-agent",
			},
		});
		expect(db.workItemRows).toHaveLength(1);
		expect(db.workItemRows[0]).toMatchObject({
			id: workItemId,
			accountableOwnerId: "tedi-cto-agent",
			disposition: "accepted",
			metadata: {
				existingCanonicalItem: true,
			},
		});
		expect(db.workAttemptRows).toHaveLength(1);
		expect(db.workAttemptRows[0]).toMatchObject({
			workItemId,
			executorId: "tedi-cto-agent",
			runtimeState: "running",
		});
		expect(result.run.metadata).toMatchObject({
			workItemId,
			delegationWorkOrder: {
				workItemId,
				executionRequirement: {
					surface: "workstation",
					requiredCapabilities: ["repository_read", "repository_edit", "tests"],
					prohibitedSurfaces: ["native", "managed_job"],
				},
			},
		});
		expect(db.approvals).toHaveLength(1);
		expect(db.approvals[0]).toMatchObject({
			actionType: "workstation.attach",
			tediId: "tedi-cto-agent",
		});
		expect(db.harnessSubjectVersionRows).toHaveLength(1);
		expect(db.harnessSubjectVersionRows[0]).toMatchObject({
			subjectKind: "kernel",
			subjectId: `kernel:${ORG_ID}`,
			components: { home_dispatch: "direct-workstation-attach-v1" },
			promotionStatus: "active",
		});
		expect(db.harnessSubjectTraceBundleRows).toHaveLength(1);
		const traceBundle = db.harnessSubjectTraceBundleRows[0]!;
		expect(traceBundle).toMatchObject({
			id: "comp-test-b:bundle",
			subjectKind: "kernel",
			subjectId: `kernel:${ORG_ID}`,
			orgId: ORG_ID,
			conversationId: "home:test",
			runId: "comp-test-b",
			outcome: "escalated",
		});
		const traceEventKinds = db.events
			.filter((event) => traceBundle.eventIds.includes(event.id))
			.map((event) => event.kind);
		expect(traceEventKinds).toEqual([
			"message.completed",
			"approval.requested",
		]);
		const traceMetadata = traceBundle.metadata as {
			bodyExecutionResult?: {
				status?: string;
				structuredResult?: Record<string, unknown>;
			};
		};
		expect(traceMetadata.bodyExecutionResult).toMatchObject({
			status: "blocked",
			structuredResult: {
				delegation: "workstation_attach",
				delegatedTediId: "tedi-cto-agent",
				childRunId: expect.any(String),
				workItemId,
				approvalRequestId: "comp-test-b",
			},
		});
	});

	it("retryRun re-dispatches a failed delegated run as a NEW run with a fresh id", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Seed a failed delegated run carrying a delegationWorkOrder.
		const failedRunId = "retry-test-failed-1";
		const delegatedTediId = "tedi-cpo";
		const delegationWorkOrder = {
			objective: "Run the quarterly capacity analysis",
			outputContract: "Return the key metrics table.",
			sourceContent: `Please run the quarterly capacity analysis for Q3.\n${"Scope context. ".repeat(300)}\nAcceptance: retain the independent oracle and both merge parents.`,
			toolGuidance: ["Use analytics tools"],
			boundaries: ["Do not write to any systems"],
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test",
				status: "failed",
				delegatedTediId,
				childRunId: "child-failed-1",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId,
					delegationWorkOrder,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		// Stub the delegate runner to succeed.
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		recordOriginalChildStop(db, failedRunId);
		const result = await client.retryRun({ runId: failedRunId });

		// The returned run is a new run (different id from the failed one).
		expect(result.newRunId).not.toBe(failedRunId);
		expect(result.run.id).toBe(result.newRunId);
		expect(result.run.status).toBe("queued");
		expect(result.run.delegatedTediId).toBe(delegatedTediId);

		// The delegate runner was called with the retried work order content.
		expect(delegateRunner).toHaveBeenCalledTimes(1);
		const dispatchCall = delegateRunner.mock.calls[0]?.[0];
		expect(dispatchCall).toMatchObject({
			delegateToTediId: delegatedTediId,
			metadata: expect.objectContaining({
				source: "kernelRuntime.retryRun",
				retriedFromRunId: failedRunId,
			}),
		});
		// Content should contain the work order framing.
		expect(typeof dispatchCall?.content).toBe("string");
		expect(dispatchCall?.content).toContain("RETRY");
		expect(dispatchCall?.content).toContain(delegationWorkOrder.sourceContent);
		expect(dispatchCall?.content).toContain(
			"Run the quarterly capacity analysis",
		);

		// A new run row was inserted in the DB.
		expect(db.runs).toHaveLength(2);
		const newRunRow = db.runs.find((r) => r.id === result.newRunId);
		expect(newRunRow).toBeDefined();
		expect(newRunRow?.status).toBe("queued");
		expect(newRunRow?.delegatedTediId).toBe(delegatedTediId);
		expect(newRunRow?.metadata).toMatchObject({
			retriedFromRunId: failedRunId,
			delegatedTediId,
		});

		// An audit event was emitted.
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.retried",
				resourceType: "kernel_run",
				resourceId: result.newRunId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.retryRun",
					retriedFromRunId: failedRunId,
					delegatedTediId,
				}),
			}),
		);

		// The original failed run is unchanged.
		const originalRun = db.runs.find((r) => r.id === failedRunId);
		expect(originalRun?.status).toBe("failed");
	});

	it("retryRun restarts a stopped delegation and still refuses a live one", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const delegatedTediId = "tedi-cpo";
		const seed = (id: string, status: "canceled" | "running") =>
			db.runs.push(
				normalizeKernelRuntimeRunInsert({
					id,
					organizationId: ORG_ID,
					conversationId: "home:retry-stopped",
					status,
					delegatedTediId,
					childRunId: `child-${id}`,
					childConversationId: "agent:main:main",
					metadata: {
						delegatedTediId,
						delegationWorkOrder: {
							objective: "Summarize the weekly threads",
							sourceContent: "Summarize the weekly threads.",
						},
					},
					createdAt: "2026-06-20T08:00:00.000Z",
					updatedAt: "2026-06-20T08:01:00.000Z",
				}),
			);
		seed("retry-stopped-1", "canceled");
		seed("retry-live-1", "running");
		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			vi.fn(async (input: { childRunId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			})),
		);

		recordOriginalChildStop(db, "retry-stopped-1");
		const result = await client.retryRun({ runId: "retry-stopped-1" });
		expect(result.newRunId).not.toBe("retry-stopped-1");
		expect(result.run.status).toBe("queued");
		await expect(client.retryRun({ runId: "retry-live-1" })).rejects.toThrow(
			/only failed or stopped runs can be retried/,
		);
	});

	it("retryRun preserves canonical Work Item correlation in the child dispatch", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);
		const failedRunId = "retry-work-item-failed-1";
		const workItemId = "11111111-1111-4111-8111-111111111111";
		const delegatedTediId = "tedi-cto";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-work-item",
				status: "failed",
				delegatedTediId,
				runtimeMetadata: { requiredProofKind: "code" },
				metadata: {
					delegatedTediId,
					delegationWorkOrder: {
						objective: "Finish the existing coding task",
						sourceContent: "Complete the canonical Work Item.",
						workItemId,
					},
				},
				createdAt: "2026-07-22T19:00:00.000Z",
				updatedAt: "2026-07-22T19:01:00.000Z",
			}),
		);
		const delegateRunner = vi.fn(async (input: { childRunId: string }) => ({
			childConversationId: "agent:main:main",
			childRunId: input.childRunId,
			status: "queued" as const,
		}));
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);

		recordOriginalChildStop(db, failedRunId);
		const result = await client.retryRun({ runId: failedRunId });

		expect(delegateRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					workItemId,
					requiredProofKind: "code",
				}),
			}),
		);
		expect(result.run.metadata).toMatchObject({ workItemId });
		expect(result.run.runtime?.metadata).toMatchObject({
			workItemId,
			requiredProofKind: "code",
		});
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "kernel.run.retried",
				metadata: expect.objectContaining({ workItemId }),
			}),
		);
	});

	it("retryRun rejects a non-failed run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Seed a running (non-terminal) run.
		const runningRunId = "retry-running-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: runningRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-2",
				status: "running",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegationWorkOrder: { objective: "Do something" },
					delegatedTediId: "tedi-cpo",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		await expect(
			client.retryRun({ runId: runningRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining('"running"'),
		});
	});

	it("retryRun rejects a failed run that has no delegationWorkOrder", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		// Case 1: no delegatedTediId at all (e.g. a kernel-inline run).
		const inlineFailedRunId = "retry-no-workorder-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: inlineFailedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-3",
				status: "failed",
				delegatedTediId: null,
				metadata: {
					// No delegationWorkOrder
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);
		await expect(
			client.retryRun({ runId: inlineFailedRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining("no delegatedTediId"),
		});

		// Case 2: has delegatedTediId but no delegationWorkOrder in metadata.
		const noWorkOrderRunId = "retry-no-workorder-2";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: noWorkOrderRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-test-3",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					// No delegationWorkOrder — e.g. a failed plain-delegation run
					// with no work order (older format or truncated metadata).
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);
		await expect(
			client.retryRun({ runId: noWorkOrderRunId }),
		).rejects.toMatchObject({
			message: expect.stringContaining("delegationWorkOrder"),
		});
	});

	it("retryRun records a dispatch failure as a terminal failed run", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-dispatch-fail-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-dispatch-fail",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					delegationWorkOrder: {
						objective: "Run the analysis",
						sourceContent: "Please run the analysis.",
					},
				},
				createdAt: "2026-06-20T08:00:00.000Z",
				updatedAt: "2026-06-20T08:01:00.000Z",
			}),
		);

		// Stub the delegate runner to fail.
		kernelRuntimeTestHooks.setDelegateRunnerForTest(async () => ({
			childRunId: "child-dispatch-fail",
			childConversationId: undefined,
			error: "target runtime unavailable",
			status: "failed" as const,
		}));

		recordOriginalChildStop(db, failedRunId);
		const result = await client.retryRun({ runId: failedRunId });

		// New run exists but is itself failed (dispatch could not reach the target).
		expect(result.run.status).toBe("failed");
		expect(result.newRunId).not.toBe(failedRunId);

		const newRunRow = db.runs.find((r) => r.id === result.newRunId);
		expect(newRunRow?.status).toBe("failed");
	});

	it("retryRun stamps kernelRoute from the FAILED run onto the audit event so home-reflection-producer can mine the rationale", async () => {
		// The failed run carried a kernelRoute when it was originally dispatched.
		// retryRun must forward it into the new run's audit event so the producer
		// can mine "Operator retried ... because: <rationale>" on the next cycle.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-g3-failed-1";
		const delegatedTediId = "tedi-cto";
		const kernelRoute = {
			routeKind: "delegate_tedi",
			rationale: "cto is the only roster member with the board context",
			confidence: 0.75,
			effortClass: "single_shot",
		};
		const delegationWorkOrder = {
			objective: "Prepare the board deck summary",
			outputContract: "Return the key slides.",
			sourceContent: "Please prepare the board deck summary for Q3.",
		};
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-g3",
				status: "failed",
				delegatedTediId,
				childRunId: "child-g3-failed",
				childConversationId: "agent:main:main",
				metadata: {
					delegatedTediId,
					delegationWorkOrder,
					kernelRoute,
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);

		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);

		recordOriginalChildStop(db, failedRunId);
		const result = await client.retryRun({ runId: failedRunId });

		expect(result.run.status).toBe("queued");
		expect(result.newRunId).not.toBe(failedRunId);

		// The audit event for the new run must carry kernelRoute from the original
		// failed run so home-reflection-producer fires the "because:" clause.
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.retried" &&
				(r as Record<string, unknown>).resourceId === result.newRunId,
		) as Record<string, unknown> | undefined;
		expect(auditRow).toBeDefined();
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		expect(auditMeta?.kernelRoute).toMatchObject({
			routeKind: "delegate_tedi",
			rationale: "cto is the only roster member with the board context",
		});
		// delegatedTediId also present (producer reads it to scope the "because:" clause).
		expect(auditMeta?.delegatedTediId).toBe(delegatedTediId);
	});

	it("fail-soft: retryRun with no kernelRoute on the failed run → audit event carries kernelRoute null", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const client = createKernelRuntimeClient(context);

		const failedRunId = "retry-g3-nosig-1";
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: failedRunId,
				organizationId: ORG_ID,
				conversationId: "home:retry-g3-nosig",
				status: "failed",
				delegatedTediId: "tedi-cpo",
				metadata: {
					delegatedTediId: "tedi-cpo",
					delegationWorkOrder: {
						objective: "Analyse Q3",
						sourceContent: "Please analyse Q3.",
					},
					// no kernelRoute — producer must emit bare fact text (no "because:")
					source: "kernelRuntime.enqueueMessage",
				},
				createdAt: "2026-06-23T08:00:00.000Z",
				updatedAt: "2026-06-23T08:01:00.000Z",
			}),
		);

		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			}),
		);

		recordOriginalChildStop(db, failedRunId);
		const result = await client.retryRun({ runId: failedRunId });

		expect(result.run.status).toBe("queued");
		const auditRow = db.auditRows.find(
			(r) =>
				(r as Record<string, unknown>).action === "kernel.run.retried" &&
				(r as Record<string, unknown>).resourceId === result.newRunId,
		) as Record<string, unknown> | undefined;
		const auditMeta = auditRow?.metadata as Record<string, unknown> | undefined;
		// Absent kernelRoute → null (fail-soft, no throw).
		expect(auditMeta?.kernelRoute).toBeNull();
	});
});

describe("proposeCodemodeExecute — delegated durable call", () => {
	it("creates the canonical approval card and parks the matching Home run", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-1",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "tedi-cto:mcp:child-1",
				metadata: {},
			}),
		);

		const result = await proposeCodemodeExecuteImpl(createContext(db), {
			tediId: "tedi-cto",
			orgId: ORG_ID,
			conversationId: "cto:delegated",
			sessionKey: "home:durable",
			executionId: "exec-1",
			codeHash: "hash-1",
			executionMode: "durable_call",
			homeRunId: "home-durable-1",
			childRunId: "tedi-cto:mcp:child-1",
			pendingSeq: 0,
			connector: "workspace",
			method: "write_file",
		});

		expect(result.status).toBe("pending");
		expect(db.approvals).toHaveLength(1);
		expect(db.approvals[0]).toMatchObject({
			actionType: "durable_code.call",
			status: "pending",
			tediId: "tedi-cto",
		});
		expect(db.runs[0]).toMatchObject({
			status: "requires_approval",
			metadata: {
				approvalRequestId: result.approvalRequestId,
				durableCodeApproval: {
					executionId: "exec-1",
					connector: "workspace",
					method: "write_file",
					status: "pending",
				},
			},
		});
	});

	it("idempotently repairs the same durable approval without duplicate cards", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-repair",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "tedi-cto:mcp:repair",
				metadata: {},
			}),
		);
		const input = {
			tediId: "tedi-cto",
			orgId: ORG_ID,
			conversationId: "cto:delegated",
			sessionKey: "home:durable",
			executionId: "exec-repair",
			codeHash: "hash-repair",
			approvalRequestId: "approval-repair-stable",
			executionMode: "durable_call" as const,
			homeRunId: "home-durable-repair",
			childRunId: "tedi-cto:mcp:repair",
			pendingSeq: 0,
			connector: "workspace",
			method: "write_file",
		};
		const first = await proposeCodemodeExecuteImpl(createContext(db), input);
		const repaired = await proposeCodemodeExecuteImpl(createContext(db), input);
		expect(repaired).toEqual(first);
		expect(db.approvals).toHaveLength(1);
		expect(
			db.auditRows.filter((row) => row.action === "approval.requested"),
		).toHaveLength(1);

		const run = db.runs[0];
		if (run) run.status = "completed";
		const approval = db.approvals[0];
		if (approval) approval.status = "approved";
		const afterApproval = await proposeCodemodeExecuteImpl(
			createContext(db),
			input,
		);
		expect(afterApproval.status).toBe("approved");
		expect(db.runs[0]?.status).toBe("completed");
	});

	it("rejects a durable approval that is not correlated to the delegated child", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-durable-2",
				organizationId: ORG_ID,
				conversationId: "home:durable",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "actual-child",
				metadata: {},
			}),
		);
		await expect(
			proposeCodemodeExecuteImpl(createContext(db), {
				tediId: "tedi-cto",
				orgId: ORG_ID,
				conversationId: "cto:delegated",
				sessionKey: "home:durable",
				executionId: "exec-2",
				codeHash: "hash-2",
				executionMode: "durable_call",
				homeRunId: "home-durable-2",
				childRunId: "spoofed-child",
				pendingSeq: 0,
				connector: "workspace",
				method: "write_file",
			}),
		).rejects.toThrow(/does not match/);
		expect(db.approvals).toHaveLength(0);
	});
});

describe("proposeRepoCommit + settle-guard", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(null);
	});

	const BASE_INPUT = {
		tediId: "tedi-cpo",
		orgId: ORG_ID,
		conversationId: "home:repo-test",
		owner: "tedix",
		repo: "ops",
		baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
		branch: "feat/add-widget",
		message: "add widget",
		openPr: false,
		prBase: null,
		changeSummary: {
			fileCount: 2,
			addedOrModified: ["src/widget.ts", "src/widget.test.ts"],
			deleted: [],
			totalBytes: 1024,
		},
		executionLedgerId: "exec-ledger-1",
		riskTier: "low" as const,
	};

	it("proposeRepoCommit creates approval row + auto-resolves low-risk trusted commit WITHOUT calling MCP executor", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const result = await proposeRepoCommitImpl(context, BASE_INPUT);

		expect(result.status).toBe("approved");
		expect(result.autoResolved).toBe(true);
		expect(result.approvalRequestId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);

		// Row created and auto-resolved
		expect(db.approvals).toHaveLength(1);
		const row = db.approvals[0];
		expect(row?.status).toBe("approved");
		expect(row?.resolvedBy).toBe("policy");
		expect(row?.actionType).toBe("home.tool_write");
		expect(row?.tediId).toBe("tedi-cpo");
		expect((row?.payload as { kind?: string })?.kind).toBe("repo_commit_write");
		expect(row?.payload).toMatchObject({
			appSlug: "repo",
			toolName: "repo_commit",
			title: "Commit 2 file(s) to tedix/ops@feat/add-widget",
			requestPreview:
				"Commit 2 file(s) to tedix/ops@feat/add-widget (base abc1234567890123456789012345678901234567)",
			executionLedgerId: "exec-ledger-1",
		});

		// Both audit events present
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				action: "approval.requested",
				resourceId: result.approvalRequestId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeRepoCommit",
					riskTier: "low",
				}),
			}),
		);
		expect(db.auditRows).toContainEqual(
			expect.objectContaining({
				actorId: "policy",
				action: "approval.approved",
				resourceId: result.approvalRequestId,
				metadata: expect.objectContaining({
					source: "kernelRuntime.proposeRepoCommit.autoResolve",
					autoResolveSource: "policy",
				}),
			}),
		);

		// MCP executor was never called
		expect(executor).not.toHaveBeenCalled();
	});

	it("proposeRepoCommit persists the exact content fingerprint onto the approval", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const fingerprint = "a1b2c3d4".repeat(8);

		await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			changeFingerprint: fingerprint,
		});

		// The anchor the publish fence compares the moving bytes against has to
		// live in D1, not only in the tedi's own DO-SQLite.
		expect(db.approvals[0]?.payload).toMatchObject({
			changeFingerprint: fingerprint,
		});
	});

	it("proposeRepoCommit records null (never a malformed anchor) when the caller sends no usable fingerprint", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		// A runtime that predates the field.
		await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(db.approvals[0]?.payload).toMatchObject({
			changeFingerprint: null,
		});

		// A malformed value is dropped rather than stored: persisting it would
		// fail parseRepoCommitWritePayload and strand the commit forever.
		await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			changeFingerprint: "not-a-sha",
		});
		expect(db.approvals[1]?.payload).toMatchObject({
			changeFingerprint: null,
		});
	});

	it("proposeRepoCommit protected-branch commit stays pending (not auto-resolved)", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "high",
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);

		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
		expect(row?.resolvedBy).toBeNull();

		// Only approval.requested, no approval.approved
		expect(db.auditRows.some((r) => r.action === "approval.requested")).toBe(
			true,
		);
		expect(db.auditRows.some((r) => r.action === "approval.approved")).toBe(
			false,
		);
	});

	it("settle-guard: settleHomeToolWriteApproval is a no-op for repo_commit_write payloads (MCP executor never called)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const fakeApproval = {
			id: "approval-rc-1",
			tediId: "tedi-cpo",
			orgId: ORG_ID,
			actionType: "home.tool_write",
			description:
				"Commit 2 file(s) to tedix/ops@feat/add-widget (base abc123...)",
			payload: {
				kind: "repo_commit_write",
				organizationId: ORG_ID,
				tediId: "tedi-cpo",
				conversationId: "home:repo-test",
				homeRunId: null,
				owner: "tedix",
				repo: "ops",
				baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
				branch: "feat/add-widget",
				message: "add widget",
				openPr: false,
				prBase: null,
				changeSummary: {
					fileCount: 2,
					addedOrModified: ["src/widget.ts"],
					deleted: [],
					totalBytes: 512,
				},
				riskTier: "low",
				executionLedgerId: "exec-ledger-1",
			},
			status: "approved" as const,
			createdAt: "2026-06-21T10:00:00.000Z",
			expiresAt: "2026-06-22T10:00:00.000Z",
			resolvedAt: "2026-06-21T10:01:00.000Z",
			resolvedBy: "policy",
			resolution: "policy-trusted low-risk write repo:repo_commit",
			workflowId: null,
		};

		await settleHomeToolWriteApproval(context, {
			approval: fakeApproval,
			status: "approved",
		});

		// MCP executor must never be called for repo_commit_write
		expect(executor).not.toHaveBeenCalled();
	});

	it("getRepoCommitApprovalStatus returns status after proposeRepoCommit", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		// Propose a commit (no trusted policy → stays pending)
		const proposed = await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(proposed.status).toBe("pending");

		// Manually look up via db.approvals (mirrors what getRepoCommitApprovalStatus does)
		const row = db.approvals.find((a) => a.id === proposed.approvalRequestId);
		expect(row).toBeDefined();
		expect(row?.status).toBe("pending");
		expect(row?.resolution).toBeNull();

		// Simulate the handler logic directly (no service-auth middleware in unit test)
		// We test via the router client with service-binding headers
		const headers = new Headers({ "X-Service-Binding": "true" });
		const serviceContext = { ...context, headers };
		const client = createRouterClient(kernelRuntimeContractRouter, {
			context: serviceContext,
		});
		const status = await client.getRepoCommitApprovalStatus({
			approvalRequestId: proposed.approvalRequestId,
			tediId: BASE_INPUT.tediId,
		});
		expect(status.status).toBe("pending");
		expect(status.resolution).toBeNull();
	});

	it("ADVERSARIAL: server ignores caller-supplied riskTier — lying 'low' for main branch stays pending", async () => {
		// Policy would auto-approve a low-risk repo_commit. The DO lies and sends
		// riskTier:'low' but branch='main'. Server recomputes 'high' and forces pending.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "low", // caller lies — server recomputes 'high'
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);
		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
		expect(row?.resolvedBy).toBeNull();
		expect(db.auditRows.some((r) => r.action === "approval.approved")).toBe(
			false,
		);
	});

	it("FIX-1: policy trustedTools covers repo:* + protected branch ('main') → still pending", async () => {
		// decideKernelWriteApproval would return autoResolve:true if riskTier were 'low',
		// but server recomputes 'high' for main and effectiveAutoResolve forces pending.
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:*"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "main",
			riskTier: "high",
		});

		expect(result.status).toBe("pending");
		expect(result.autoResolved).toBe(false);
		const row = db.approvals[0];
		expect(row?.status).toBe("pending");
	});

	it("FIX-1: session allowlist + feature branch ('feat/x') → auto-approved (low-risk honored)", async () => {
		const db = createKernelRuntimeDb({
			policyPackRows: [
				{
					definition: {
						governancePolicy: {
							writeTier: { trustedTools: ["repo:repo_commit"] },
						},
					},
				},
			],
		});
		const context = createContext(db);

		const result = await proposeRepoCommitImpl(context, {
			...BASE_INPUT,
			branch: "feat/x",
			riskTier: "low",
		});

		expect(result.status).toBe("approved");
		expect(result.autoResolved).toBe(true);
		const row = db.approvals[0];
		expect(row?.status).toBe("approved");
	});

	it("FIX-2: getRepoCommitApprovalStatus — wrong tediId returns NOT_FOUND", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);

		const proposed = await proposeRepoCommitImpl(context, BASE_INPUT);
		expect(proposed.status).toBe("pending");

		const headers = new Headers({ "X-Service-Binding": "true" });
		const serviceContext = { ...context, headers };
		const client = createRouterClient(kernelRuntimeContractRouter, {
			context: serviceContext,
		});

		// Wrong tediId → NOT_FOUND (no information about who owns the row)
		await expect(
			client.getRepoCommitApprovalStatus({
				approvalRequestId: proposed.approvalRequestId,
				tediId: "tedi-attacker",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Correct tediId → returns status
		const status = await client.getRepoCommitApprovalStatus({
			approvalRequestId: proposed.approvalRequestId,
			tediId: BASE_INPUT.tediId,
		});
		expect(status.status).toBe("pending");
	});

	it("FIX-3 repo_commit_write settle triggers tedi DO drain and never calls MCP executor", async () => {
		const db = createKernelRuntimeDb();
		const runtimeFetch = vi.fn(async () =>
			Response.json({ ok: true, drained: true }),
		);
		const context = createContext(db, {
			env: {
				TEDI_SERVICE: { fetch: runtimeFetch },
			},
		});

		const executor = vi.fn(async () => ({ ok: true as const, data: {} }));
		kernelRuntimeTestHooks.setKernelWriteExecutorForTest(
			executor as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelWriteExecutorForTest
			>[0],
		);

		const fakeApproval = {
			id: "approval-rc-guard",
			tediId: "tedi-cpo",
			orgId: ORG_ID,
			actionType: "home.tool_write",
			description: "Commit 1 file(s) to tedix/ops@feat/add-widget",
			payload: {
				kind: "repo_commit_write",
				organizationId: ORG_ID,
				tediId: "tedi-cpo",
				conversationId: "home:repo-test",
				homeRunId: null,
				owner: "tedix",
				repo: "ops",
				baseRef: "abc1234567890123456789012345678901234567890".slice(0, 40),
				branch: "feat/add-widget",
				message: "add widget",
				openPr: false,
				prBase: null,
				changeSummary: {
					fileCount: 1,
					addedOrModified: ["src/widget.ts"],
					deleted: [],
					totalBytes: 512,
				},
				riskTier: "low",
				executionLedgerId: "exec-ledger-guard",
			},
			status: "approved" as const,
			createdAt: "2026-06-21T10:00:00.000Z",
			expiresAt: "2026-06-22T10:00:00.000Z",
			resolvedAt: "2026-06-21T10:01:00.000Z",
			resolvedBy: "policy",
			resolution: "policy-trusted low-risk write repo:repo_commit",
			workflowId: null,
		};

		await settleHomeToolWriteApproval(context, {
			approval: fakeApproval,
			status: "approved",
		});
		await Promise.all(context.waitUntilPromises);

		expect(runtimeFetch).toHaveBeenCalledTimes(1);
		const [url, init] = runtimeFetch.mock.calls[0] ?? [];
		expect(String(url)).toContain("/__internal/repo-commit/drain");
		expect((init as RequestInit | undefined)?.method).toBe("POST");
		const drainHeaders = (init as RequestInit | undefined)?.headers as
			| Record<string, string>
			| undefined;
		expect(drainHeaders).toBeDefined();
		expect(drainHeaders?.["X-Service-Binding"]).toBe("true");
		expect(
			JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")),
		).toMatchObject({
			approvalRequestId: "approval-rc-guard",
			executionLedgerId: "exec-ledger-guard",
			status: "approved",
		});
		expect(executor).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Fan-out child-tree: buildFanoutChildNodes + augmentTreeWithFanoutChildren
// ---------------------------------------------------------------------------

describe("operator slash commands are never routed as objectives", () => {
	// Regression: `/retry <id>` sent as a message became a new objective on a new
	// work item titled after the command text, while the item it named stayed
	// blocked. Every text surface must refuse it the same way.
	it("detects operator verbs on the first line", () => {
		expect(detectOperatorSlashCommand("/retry 5eed0001")).toBe("retry");
		expect(detectOperatorSlashCommand("  /Cancel abc  ")).toBe("cancel");
		expect(
			detectOperatorSlashCommand("/retry 5eed0001\n\nLocal terminal context:"),
		).toBe("retry");
	});

	it("leaves ordinary prose and unknown verbs alone", () => {
		expect(detectOperatorSlashCommand("summarize the run set")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("/Users/owner/x.md is stale"),
		).toBeUndefined();
		expect(detectOperatorSlashCommand("/2026 targets")).toBeUndefined();
		expect(detectOperatorSlashCommand("/definitelynotaverb x")).toBeUndefined();
		expect(detectOperatorSlashCommand("/")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("please run /retry for me"),
		).toBeUndefined();
	});

	it("refuses the enqueue instead of minting a work item", async () => {
		const db = createKernelRuntimeDb();
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.enqueueMessage({
				conversationId: "home:test",
				content: "/retry 5eed0001-0000-4000-8000-000000000001",
				idempotencyKey: "home-slash-1",
			}),
		).rejects.toThrow(/operator command, not a message/);
	});

	// The OS composer's skill picker writes `/skill <slug>` ABOVE the operator's
	// prose. Reading literally the first line would classify the reference as
	// "not a command" and let the real command underneath through unrefused.
	it("steps over leading skill references to find the real command", () => {
		expect(
			detectOperatorSlashCommand("/skill deploy-runbook\n\n/retry 5eed0001"),
		).toBe("retry");
		expect(
			detectOperatorSlashCommand(
				"/skill deploy-runbook\n/skill audit-costs\n\n/cancel abc",
			),
		).toBe("cancel");
	});

	it("never refuses a skill reference as a command of its own", () => {
		// A reference is a reference. Claiming the verb would refuse every
		// picker insertion the composer makes.
		expect(SKILL_REFERENCE_VERB).toBe("skill");
		expect(detectOperatorSlashCommand("/skill deploy-runbook")).toBeUndefined();
		expect(
			detectOperatorSlashCommand("/skill deploy-runbook\n\nship the widget"),
		).toBeUndefined();
	});

	it("still reads a leading token that only looks like a reference", () => {
		// Not the reference grammar (no slug), so it is ordinary prose again.
		expect(detectOperatorSlashCommand("/skill\n/retry abc")).toBeUndefined();
	});
});

describe("operator skill references are resolved before the turn is billed", () => {
	// A picker that inserts a reference nothing resolves is a visible affordance
	// that silently does nothing. Refuse at enqueue, naming the slug, so the
	// operator fixes it instead of wondering why the skill was ignored.
	it("refuses a reference that resolves to no readable skill", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue(undefined);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await expect(
				client.enqueueMessage({
					conversationId: "home:test",
					content: "/skill ghost\n\nship the widget",
					idempotencyKey: "home-skill-ref-1",
				}),
			).rejects.toThrow(/did not resolve to a usable skill/);
		} finally {
			read.mockRestore();
		}
	});

	it("names the exact slug that failed, not just that something did", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue(undefined);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await expect(
				client.enqueueMessage({
					conversationId: "home:test",
					content: "/skill deploy-runbook\n\nship the widget",
					idempotencyKey: "home-skill-ref-2",
				}),
			).rejects.toThrow(/"\/skill deploy-runbook"/);
		} finally {
			read.mockRestore();
		}
	});

	it("lets a resolvable reference through and enqueues the turn", async () => {
		const read = vi
			.spyOn(skillCrudQueries, "getSkillEntryBySlug")
			.mockResolvedValue({
				id: "skill-deploy",
				organizationId: "org-1",
				title: "Deploy runbook",
				slug: "deploy-runbook",
				content: "1. run the deploy script",
				tediId: null,
				visibility: "org",
				lifecycleState: "proven",
			} as unknown as Awaited<
				ReturnType<typeof skillCrudQueries.getSkillEntryBySlug>
			>);
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			const result = await client.enqueueMessage({
				conversationId: "home:test",
				content: "/skill deploy-runbook\n\nship the widget",
				idempotencyKey: "home-skill-ref-ok",
			});
			expect(result.conversationId).toBe("home:test");
			expect(read).toHaveBeenCalledWith(
				expect.anything(),
				"org-1",
				"deploy-runbook",
			);
		} finally {
			read.mockRestore();
		}
	});

	it("lets a message with no skill reference through without any skill read", async () => {
		const read = vi.spyOn(skillCrudQueries, "getSkillEntryBySlug");
		try {
			const db = createKernelRuntimeDb();
			const client = createKernelRuntimeClient(createContext(db));
			await client.enqueueMessage({
				conversationId: "home:test",
				content: "ship the widget",
				idempotencyKey: "home-skill-ref-3",
			});
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	});
});

describe("workstation admission runtime identity", () => {
	function fixture(automatic: boolean) {
		const db = createKernelRuntimeDb();
		const target = db.tediRows.find((row) => row.id === "tedi-cto-agent")!;
		Object.assign(target, {
			isolateAgentId: "cto-rebind-1782139014003",
			runtimeStatus: "running",
		});
		const context = createContext(db, {
			env: { WORKSTATION_AUTO_DISPATCH_ENABLED: automatic ? "true" : "false" },
			...(automatic ? { userSub: "operator-1" } : {}),
		}) as BaseContext & { waitUntilPromises: Promise<unknown>[] };
		const client = createKernelRuntimeClient(context);
		const workItemId = crypto.randomUUID();
		db.workItemRows.push(
			normalizeWorkItemInsert({
				id: workItemId,
				orgId: ORG_ID,
				title: "Supervised workstation task",
				disposition: "accepted",
				accountableOwnerType: "tedi",
				accountableOwnerId: target.id,
				workKind: "coding",
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2099-01-01T00:00:00.000Z",
				createdAt: new Date().toISOString(),
			}),
		);
		const delegateRunner = vi.fn(
			async (input: { childRunId: string; delegateToTediId: string }) => ({
				childRunId: predictAgentRunId({
					clientRequestId: input.childRunId,
					tediId: input.delegateToTediId,
				}),
				status: "queued" as const,
			}),
		);
		kernelRuntimeTestHooks.setDelegateRunnerForTest(delegateRunner);
		const enqueue = async (homeRunId: string) => {
			const result = await client.enqueueMessage({
				conversationId: "home:test",
				content: "Run the bounded native command",
				delegateToTediId: target.id,
				idempotencyKey: homeRunId,
				metadata: { requireWorkstation: true, workItemId },
			});
			await Promise.all(context.waitUntilPromises);
			return result;
		};
		const approve = (homeRunId: string) => {
			const approval = db.approvals.find((row) => row.id === homeRunId)!;
			approval.status = "approved";
			return resolveKernelWorkstationAttachWorkOrder(context, {
				approvalRequestId: approval.id,
				organizationId: ORG_ID,
				status: "approved",
			});
		};
		return {
			db,
			target,
			context,
			client,
			workItemId,
			delegateRunner,
			enqueue,
			approve,
		};
	}

	it("automatic dispatch admits the canonical runtime run before sending the unchanged delivery key", async () => {
		const f = fixture(true);
		await f.enqueue("identity-auto");
		expect(f.db.workAttemptRows).toHaveLength(1);
		expect(f.db.workAttemptRows[0]).toMatchObject({
			runId: "tedi-cto-agent:mcp:identity-auto_workstation_tedi-cto-agent",
			executorType: "tedi",
			executorId: "tedi-cto-agent",
			orgId: ORG_ID,
		});
		expect(f.delegateRunner).toHaveBeenCalledTimes(1);
		expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
			"identity-auto:workstation:tedi-cto-agent",
		);
		expect(
			f.db.runs.find((row) => row.id === "identity-auto")?.childRunId,
		).toBe(f.db.workAttemptRows[0]!.runId);
	});

	it("approved attachment dispatch uses the original exact admission without replacing its Attempt", async () => {
		const f = fixture(false);
		await f.enqueue("identity-approved");
		expect(f.delegateRunner).not.toHaveBeenCalled();
		const before = structuredClone(f.db.workAttemptRows[0]);
		expect(before).toMatchObject({
			runtimeState: "running",
			expiresAt: expect.any(String),
		});
		expect(before!.expiresAt! > new Date().toISOString()).toBe(true);
		const result = await f.approve("identity-approved");
		expect(f.db.workAttemptRows).toEqual([before]);
		expect(result.run.childRunId).toBe(
			"tedi-cto-agent:mcp:identity-approved_workstation_tedi-cto-agent",
		);
		expect(result.run.childRunId).toBe(before!.runId);
		expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
			"identity-approved:workstation:tedi-cto-agent",
		);
	});

	it.each([
		"raw_run",
		"wrong_executor",
		"expired",
		"terminal_attempt",
		"terminal_home",
		"missing_target",
		"cross_org_target",
	] as const)(
		"approved attachment fails closed for %s without rewriting authority or dispatching",
		async (failure) => {
			const f = fixture(false);
			const home = `identity-${failure}`;
			await f.enqueue(home);
			const attempt = f.db.workAttemptRows[0]!;
			if (failure === "raw_run")
				attempt.runId = `${home}:workstation:tedi-cto-agent`;
			if (failure === "wrong_executor") attempt.executorId = "tedi-cpo";
			if (failure === "expired") attempt.expiresAt = "2000-01-01T00:00:00.000Z";
			if (failure === "terminal_attempt") attempt.runtimeState = "completed";
			if (failure === "terminal_home")
				f.db.runs.find((row) => row.id === home)!.status = "canceled";
			if (failure === "missing_target")
				f.db.tediRows.splice(f.db.tediRows.indexOf(f.target), 1);
			if (failure === "cross_org_target") f.target.organizationId = "other-org";
			const before = structuredClone(f.db.workAttemptRows);
			const homeBefore = structuredClone(
				f.db.runs.find((row) => row.id === home),
			);
			await expect(f.approve(home)).rejects.toThrow();
			expect(f.delegateRunner).not.toHaveBeenCalled();
			expect(f.db.workAttemptRows).toEqual(before);
			expect(f.db.runs.find((row) => row.id === home)).toEqual(homeBefore);
		},
	);

	it.each(["2099-01-01T00:00:00.000Z", null, "not-a-date", ""])(
		"automatic reentry rejects a raw-key Attempt with expiry %j without changing it",
		async (expiresAt) => {
			const f = fixture(true);
			const attempt = {
				...runningWorkAttempt(
					f.workItemId,
					f.target.id,
					"identity-raw:workstation:tedi-cto-agent",
				),
				admissionId: "existing-admission",
				expiresAt,
			};
			f.db.workAttemptRows.push(attempt);
			const before = structuredClone(attempt);
			await expect(f.enqueue("identity-raw")).rejects.toThrow(
				/exact admitted runtime run/,
			);
			expect(f.delegateRunner).not.toHaveBeenCalled();
			expect(f.db.workAttemptRows).toEqual([before]);
		},
	);

	it("a valid expired Attempt permits fresh canonical admission without rewriting history", async () => {
		const f = fixture(true);
		const expired = {
			...runningWorkAttempt(
				f.workItemId,
				f.target.id,
				"identity-expired:workstation:tedi-cto-agent",
			),
			admissionId: "old-admission",
			expiresAt: "2000-01-01T00:00:00.000Z",
		};
		f.db.workAttemptRows.push(expired);
		const before = structuredClone(expired);
		await f.enqueue("identity-expired");
		expect(f.db.workAttemptRows).toHaveLength(2);
		expect(f.db.workAttemptRows[0]).toEqual(before);
		expect(f.db.workAttemptRows[1]!.runId).toBe(
			"tedi-cto-agent:mcp:identity-expired_workstation_tedi-cto-agent",
		);
		expect(f.delegateRunner).toHaveBeenCalledTimes(1);
	});

	it.each(["requires_approval", "canceled"] as const)(
		"workstation recommendation with Home status %s preserves admission and terminal fences",
		async (status) => {
			const f = fixture(false);
			const homeRunId = "identity-recommendation";
			const workOrder = {
				id: `work-order:${homeRunId}`,
				objective: "Run the bounded native command",
				sourceContent: "Run the bounded native command",
				outputContract: "Return exact command output",
				targetTediId: f.target.id,
				executionRequirement: {
					surface: "workstation",
					requiredCapabilities: ["process"],
					fallbackSurface: null,
					prohibitedSurfaces: [],
					satisfiable: true,
					reason: "approved workstation task",
				},
			};
			const run = normalizeKernelRuntimeRunInsert({
				id: homeRunId,
				organizationId: ORG_ID,
				conversationId: "home:test",
				status,
				delegatedTediId: f.target.id,
				metadata: {
					workItemId: f.workItemId,
					homeDelegation: {
						targetTediId: f.target.id,
						status: "requires_approval",
						workOrder,
						decision: {
							mode: "needs_approval",
							canAutoDispatch: false,
							reason: "operator approval",
						},
					},
					delegationWorkOrder: workOrder,
				},
				createdAt: new Date().toISOString(),
			});
			f.db.runs.push(run);
			if (status === "canceled") {
				const before = structuredClone({
					runs: f.db.runs,
					events: f.db.events,
					workItems: f.db.workItemRows,
					attempts: f.db.workAttemptRows,
				});
				await expect(
					respondKernelDelegationRecommendationApprovalCore(f.context, {
						run,
						organizationId: ORG_ID,
						decision: "approve",
					}),
				).rejects.toThrow(/Terminal Home run/);
				expect(f.delegateRunner).not.toHaveBeenCalled();
				expect({
					runs: f.db.runs,
					events: f.db.events,
					workItems: f.db.workItemRows,
					attempts: f.db.workAttemptRows,
				}).toEqual(before);
				return;
			}
			const result = await respondKernelDelegationRecommendationApprovalCore(
				f.context,
				{ run, organizationId: ORG_ID, decision: "approve" },
			);
			expect(f.db.workAttemptRows).toHaveLength(1);
			expect(f.db.workAttemptRows[0]!.runId).toBe(
				"tedi-cto-agent:mcp:identity-recommendation_workstation_tedi-cto-agent",
			);
			expect(f.delegateRunner.mock.calls[0]![0].childRunId).toBe(
				"identity-recommendation:workstation:tedi-cto-agent",
			);
			expect(result.run.childRunId).toBe(f.db.workAttemptRows[0]!.runId);
		},
	);
});

describe("respondApproval — held Home delegation authority and agent review fence", () => {
	afterEach(() => {
		kernelRuntimeTestHooks.setDelegateRunnerForTest(null);
		kernelRuntimeTestHooks.setKernelForTest(null);
	});

	async function parkHeldDelegation(
		db: ReturnType<typeof createKernelRuntimeDb>,
		runId: string,
		agentReview?: Record<string, unknown>,
	) {
		kernelRuntimeTestHooks.setKernelForTest(
			vi.fn(async () => ({
				assistantContent: "I prepared a delegation to CPO.",
				route: {
					routeKind: "delegate_tedi" as const,
					rationale: "CPO owns product",
					risk: "high" as const,
					confidence: 0.9,
					effortClass: null,
					answer: null,
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					toolIntent: null,
					workflowHint: null,
					clarifyingQuestion: null,
					evidenceExpectation: null,
				},
				delegation: {
					workOrder: {
						objective: "Review the roadmap",
						executionRequirement: NATIVE_EXECUTION_REQUIREMENT,
						outputContract: "Return a short summary",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Have CPO review the roadmap.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					},
					decision: {
						canAutoDispatch: false,
						mode: "needs_approval",
						approvalRoute: "agent",
						reason: "route classified as high risk",
					},
					...(agentReview ? { agentReview } : {}),
				},
			})) as unknown as Parameters<
				typeof kernelRuntimeTestHooks.setKernelForTest
			>[0],
		);
		await createKernelRuntimeClient(createContext(db)).enqueueMessage({
			conversationId: "home:test",
			content: "Have CPO review the roadmap.",
			idempotencyKey: runId,
		});
		kernelRuntimeTestHooks.setDelegateRunnerForTest(
			vi.fn(async (input: { childRunId: string }) => ({
				childConversationId: "agent:main:main",
				childRunId: input.childRunId,
				status: "queued" as const,
			})),
		);
	}

	function serviceBindingClient(
		db: ReturnType<typeof createKernelRuntimeDb>,
		headers: Record<string, string>,
		member?: { role: string; status: string },
	) {
		(db as unknown as { query: unknown }).query = {
			organizationMembers: {
				findFirst: vi.fn(async () =>
					member ? { ...member, organizationId: ORG_ID } : undefined,
				),
			},
		};
		const context = createContext(db);
		return createKernelRuntimeClient({
			...context,
			apiKey: undefined,
			authType: undefined,
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": ORG_ID,
				"X-Tedix-Tedi-Scopes": "tedis:write tedis:read mcp:memory.admin",
				...headers,
			}),
		} as unknown as BaseContext);
	}

	const PENDING_REVIEW = {
		status: "pending",
		approverTediId: "tedi-cto",
		approverTediLabel: "CTO",
		proposalId: "proposal-1",
		workItemId: "wi-held-1",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};

	it("refuses an operator without owner/admin authority", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-member-1");
		const client = serviceBindingClient(
			db,
			{ "X-Tedix-Acting-User": "member-user" },
			{ role: "member", status: "active" },
		);
		await expect(
			client.respondApproval({ runId: "held-member-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("owner or admin"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});

	it("refuses a tedi principal on the operator path", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-tedi-1");
		const client = serviceBindingClient(db, {
			"X-Tedix-Tedi-Id": "tedi-cpo",
		});
		await expect(
			client.respondApproval({ runId: "held-tedi-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("Work approval plane"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});

	it("lets an admin approve an ordinary held delegation", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-admin-1");
		const client = serviceBindingClient(
			db,
			{ "X-Tedix-Acting-User": "admin-user" },
			{ role: "admin", status: "active" },
		);
		const result = await client.respondApproval({
			runId: "held-admin-1",
			decision: "approve",
		});
		expect(result.run.status).toBe("queued");
	});

	it("returns CONFLICT on approve while the agent review is pending, but allows reject", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-pending-1", PENDING_REVIEW);
		const client = createKernelRuntimeClient(createContext(db));
		await expect(
			client.respondApproval({ runId: "held-pending-1", decision: "approve" }),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("awaiting CTO"),
		});
		expect(db.workItemRows).toHaveLength(0);

		const rejected = await client.respondApproval({
			runId: "held-pending-1",
			decision: "reject",
			note: "not now",
		});
		expect(rejected.run.status).toBe("canceled");
	});

	it.each([
		[
			"the review expired",
			{ ...PENDING_REVIEW, expiresAt: "2020-01-01T00:00:00.000Z" },
		],
		[
			"the approver declined",
			{ ...PENDING_REVIEW, status: "rejected", rationale: "frozen" },
		],
		[
			"the review was unavailable",
			{ ...PENDING_REVIEW, status: "unavailable", reason: "no tools" },
		],
	])("lets the operator approve once %s", async (_label, review) => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-fallback-1", review);
		const result = await createKernelRuntimeClient(
			createContext(db),
		).respondApproval({ runId: "held-fallback-1", decision: "approve" });
		expect(result.run.status).toBe("queued");
	});

	it("latches atomically: a resolver holding a stale read loses with CONFLICT", async () => {
		const db = createKernelRuntimeDb();
		await parkHeldDelegation(db, "held-race-1");
		const context = createContext(db);
		const stale = structuredClone(db.runs.find((r) => r.id === "held-race-1")!);
		await createKernelRuntimeClient(context).respondApproval({
			runId: "held-race-1",
			decision: "reject",
		});
		await expect(
			respondKernelDelegationRecommendationApprovalCore(context, {
				decision: "approve",
				organizationId: ORG_ID,
				run: stale as unknown as Parameters<
					typeof respondKernelDelegationRecommendationApprovalCore
				>[1]["run"],
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("changed while it was being resolved"),
		});
		expect(db.workItemRows).toHaveLength(0);
	});
});

describe("readConversationEvents", () => {
	it("pages the conversation's run-free events and excludes run-scoped events", async () => {
		const db = createKernelRuntimeDb();
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:conv-events`,
				organizationId: ORG_ID,
				conversationId: "home:conv-events",
				lastMessageAt: "2026-07-22T19:00:00.000Z",
			}),
		);
		db.events.push(
			normalizeKernelRuntimeEventInsert({
				id: "evt-title",
				organizationId: ORG_ID,
				conversationId: "home:conv-events",
				kind: "conversation.updated",
				payload: { title: "Renamed" },
				createdAt: "2026-07-22T19:01:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "evt-pin",
				organizationId: ORG_ID,
				conversationId: "home:conv-events",
				kind: "conversation.updated",
				payload: { pinned: true },
				createdAt: "2026-07-22T19:02:00.000Z",
			}),
			normalizeKernelRuntimeEventInsert({
				id: "evt-run",
				organizationId: ORG_ID,
				conversationId: "home:conv-events",
				runId: "home-run-1",
				kind: "run.started",
				createdAt: "2026-07-22T19:03:00.000Z",
			}),
		);
		const result = await createKernelRuntimeClient(
			createContext(db),
		).readConversationEvents({ conversationId: "home:conv-events" });
		expect(result.events.map((event) => event.id)).toEqual([
			"evt-title",
			"evt-pin",
		]);
		expect(result.stream).toMatchObject({
			streamId: "home:conversation:home:conv-events",
			offset: 0,
			nextOffset: 2,
			closed: false,
		});
	});

	it("serves a deterministic terminal tombstone frame once the ledger is purged", async () => {
		const db = createKernelRuntimeDb();
		db.conversationIndexRows.push(
			normalizeKernelConversationInsert({
				id: `${ORG_ID}:home:deleted-conv`,
				organizationId: ORG_ID,
				conversationId: "home:deleted-conv",
				lastMessageAt: "2026-07-22T19:00:00.000Z",
				deletedAt: "2026-07-22T19:30:00.000Z",
			}),
		);
		// No event rows: deleteConversation purged the ledger, leaving the
		// content-free tombstone the terminal frame is derived from.
		const result = await createKernelRuntimeClient(
			createContext(db),
		).readConversationEvents({ conversationId: "home:deleted-conv" });
		expect(result.events).toHaveLength(1);
		const frame = result.events[0];
		expect(frame).toMatchObject({
			kind: "conversation.updated",
			conversationId: "home:deleted-conv",
			createdAt: "2026-07-22T19:30:00.000Z",
		});
		expect(frame?.id).toContain("deleted:2026-07-22T19:30:00.000Z");
		expect(frame?.payload).toMatchObject({
			conversation: { deletedAt: "2026-07-22T19:30:00.000Z" },
		});
		expect(result.stream).toMatchObject({
			offset: 0,
			nextOffset: 1,
			closed: true,
			terminalEventId: frame?.id,
		});
	});
});
