import { DatabaseSync } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelRuntimeRuns,
	kernelRuntimeEvents,
	chatDispatchIdempotency,
} from "../schema/cognitive-runtime";
import { workItems, workAttempts } from "../schema/work-items";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	beginApprovedHomeDelegationResumeDispatch,
	recordApprovedHomeDelegationResumeDispatch,
	claimApprovedHomeDelegationResume,
	compareAndTouchKernelRuntimeRun,
	getKernelRuntimeRun,
	updateKernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
	transitionKernelRuntimeRunStatus,
	markHomeDelegationResolutionAdmissionFailed,
	parseApprovedHomeDelegationResumeScope,
	recordApprovedHomeDelegationResumeStopOutcome,
	type ClaimApprovedHomeDelegationResumeParams,
} from "./kernel-runtime-runs";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [
		kernelRuntimeRuns,
		kernelRuntimeEvents,
		workItems,
		workAttempts,
		chatDispatchIdempotency,
		runtimeSubmissions,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const expectedMetadata = {
		homeDelegation: {
			decision: { mode: "needs_approval", approvalRoute: "human" },
			workOrder: {
				targetTediId: "tedi-fixture",
				objective: "Original bounded task",
			},
		},
		keep: "untouched",
	};
	const at = "2026-11-04T09:00:00.000Z";
	await db.insert(workItems).values({
		id: "work-fixture",
		orgId: "org-fixture",
		title: "Existing Work",
		disposition: "accepted",
		version: 7,
		admissionSpecRevision: "spec-fixture",
		createdAt: "2026-11-04T09:00:00.000Z",
		updatedAt: "2026-11-04T09:00:00.000Z",
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-fixture",
		organizationId: "org-fixture",
		conversationId: "conversation-fixture",
		status: "requires_approval",
		createdAt: at,
		updatedAt: at,
		latestEventAt: at,
		metadata: expectedMetadata,
		runtimeMetadata: { workItemId: "work-fixture" },
	});
	await db.insert(kernelRuntimeEvents).values({
		id: "approval-event",
		organizationId: "org-fixture",
		conversationId: "conversation-fixture",
		runId: "run-fixture",
		kind: "approval.resolved",
		createdAt: at,
		payload: {
			status: "approved",
			resolvedBy: { type: "user", id: "original-human" },
			delegationWorkOrder: {
				targetTediId: "tedi-fixture",
				objective: "Original bounded task",
			},
		},
	});
	const params: ClaimApprovedHomeDelegationResumeParams = {
		organizationId: "org-fixture",
		runId: "run-fixture",
		conversationId: "conversation-fixture",
		expectedUpdatedAt: at,
		expectedLatestEventAt: at,
		expectedMetadata,
		approvalEventId: "approval-event",
		approvalResolvedAt: at,
		workItemId: "work-fixture",
		workItemVersion: 7,
		admissionSpecRevision: "spec-fixture",
		scopeDigest: "a".repeat(64),
		targetTediId: "tedi-fixture",
		expectedChildRunId: "child-fixture",
		claimId: "claim-fixture",
		now: "2026-11-04T09:05:00.000Z",
	};
	const read = () =>
		getKernelRuntimeRun(db, {
			id: params.runId,
			organizationId: params.organizationId,
		});
	return { db, params, read, sqlite };
}

describe("recorded Home approval resume claim", () => {
	it("claims the exact run and preserves original receipt, actor, scope and Work binding", async () => {
		const f = await fixture();
		const [beforeReceipt] = await f.db.select().from(kernelRuntimeEvents);
		const run = await claimApprovedHomeDelegationResume(f.db, f.params);
		expect(run?.metadata).toEqual({
			...f.params.expectedMetadata,
			homeDelegation: {
				...(f.params.expectedMetadata.homeDelegation as object),
				resolutionStatus: "approved",
				resolvedAt: f.params.approvalResolvedAt,
				resolution: null,
				resolvedBy: { type: "user", id: "original-human" },
			},
			delegationWorkOrder: {
				targetTediId: "tedi-fixture",
				objective: "Original bounded task",
			},
			homeDelegationResume: {
				version: 1,
				phase: "claimed",
				claimId: f.params.claimId,
				approvalEventId: f.params.approvalEventId,
				approvalResolvedAt: f.params.approvalResolvedAt,
				workItemId: f.params.workItemId,
				workItemVersion: 7,
				admissionSpecRevision: "spec-fixture",
				scopeDigest: f.params.scopeDigest,
				targetTediId: f.params.targetTediId,
				expectedChildRunId: f.params.expectedChildRunId,
				claimedAt: f.params.now,
			},
		});
		expect(run?.runtimeMetadata).toEqual({ workItemId: "work-fixture" });
		expect(run?.status).toBe("requires_approval");
		expect((await f.db.select().from(kernelRuntimeEvents))[0]).toEqual(
			beforeReceipt,
		);
	});
	it("lets only one of two actual concurrent claimants win", async () => {
		const f = await fixture();
		const results = await Promise.all([
			claimApprovedHomeDelegationResume(f.db, f.params),
			claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				claimId: "other-claim",
			}),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
	it.each([
		[
			"run metadata",
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.keep','changed')",
		],
		[
			"run timestamp",
			"UPDATE kernel_runtime_runs SET updated_at='2026-11-04T09:01:00.000Z'",
		],
		[
			"fresh event",
			"UPDATE kernel_runtime_runs SET latest_event_at='2026-11-04T09:01:00.000Z'",
		],
		["child", "UPDATE kernel_runtime_runs SET child_run_id='child'"],
		[
			"delegated tedi",
			"UPDATE kernel_runtime_runs SET delegated_tedi_id='tedi'",
		],
		[
			"child conversation",
			"UPDATE kernel_runtime_runs SET child_conversation_id='child-conversation'",
		],
		["cancellation", "UPDATE kernel_runtime_runs SET status='canceled'"],
		[
			"existing claim",
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.homeDelegationResume',json('{}'))",
		],
		["Work version", "UPDATE work_items SET version=8"],
		[
			"Work specification",
			"UPDATE work_items SET admission_spec_revision='new-spec'",
		],
		["Work disposition", "UPDATE work_items SET disposition='completed'"],
		["Work tenant", "UPDATE work_items SET org_id='other-org'"],
		[
			"receipt tenant",
			"UPDATE kernel_runtime_events SET organization_id='other-org'",
		],
		["receipt run", "UPDATE kernel_runtime_events SET run_id='other-run'"],
		[
			"receipt conversation",
			"UPDATE kernel_runtime_events SET conversation_id='other-conversation'",
		],
		[
			"receipt rejection",
			"UPDATE kernel_runtime_events SET payload=json_set(payload,'$.status','rejected')",
		],
		[
			"receipt timestamp",
			"UPDATE kernel_runtime_events SET created_at='2026-11-04T09:01:00.000Z'",
		],
		[
			"selected binding",
			"UPDATE kernel_runtime_runs SET runtime_metadata=json_set(runtime_metadata,'$.workItemId','other-work')",
		],
	])(
		"refuses a raced %s without rewriting any row",
		async (_name, mutation) => {
			const f = await fixture();
			f.sqlite.exec(mutation);
			const before = await f.read();
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).toBeNull();
			expect(await f.read()).toEqual(before);
		},
	);
	it("does not retarget another accepted Work", async () => {
		const f = await fixture();
		await f.db.insert(workItems).values({
			id: "other-work",
			orgId: "org-fixture",
			title: "Different",
			disposition: "accepted",
			version: 7,
			admissionSpecRevision: "spec-fixture",
			createdAt: f.params.approvalResolvedAt,
			updatedAt: f.params.approvalResolvedAt,
		});
		expect(
			await claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				workItemId: "other-work",
			}),
		).toBeNull();
	});
	it("honors durable abort before the parent run status changes", async () => {
		const f = await fixture();
		await f.db.insert(runtimeSubmissions).values({
			id: "sub-run",
			organizationId: f.params.organizationId,
			subjectKind: "kernel",
			subjectId: "kernel:org-fixture",
			runId: f.params.runId,
			conversationId: f.params.conversationId,
			sourceKind: "home",
			status: "running",
			abortRequestedAt: f.params.now,
		});
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
		expect((await f.read())?.status).toBe("requires_approval");
	});
	it("uses the saved runtime binding only when no current binding exists", async () => {
		const f = await fixture();
		const metadata = {
			...f.params.expectedMetadata,
			redriveInput: { runtimeMetadata: { workItemId: f.params.workItemId } },
		};
		await f.db.update(kernelRuntimeRuns).set({ metadata, runtimeMetadata: {} });
		f.params.expectedMetadata = metadata;
		expect(
			await claimApprovedHomeDelegationResume(f.db, f.params),
		).not.toBeNull();
	});
	it.each([
		"redriveInput.runtimeMetadata.workItemId",
		"homeDelegation.workOrder.workItemId",
	])("rejects conflicting persisted %s", async (path) => {
		const f = await fixture();
		await f.db.update(kernelRuntimeRuns).set({
			metadata: sql`json_set(${kernelRuntimeRuns.metadata}, ${"$." + path}, 'other-work')`,
		});
		const current = await f.read();
		f.params.expectedMetadata = current!.metadata!;
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	});
	it("requires an exact canonical receipt", async () => {
		const f = await fixture();
		expect(
			await claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				approvalEventId: "missing-event",
			}),
		).toBeNull();
	});
	it("supports a recorded null latest-event snapshot without treating it as a wildcard", async () => {
		const f = await fixture();
		await f.db.update(kernelRuntimeRuns).set({ latestEventAt: null });
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
		expect(
			await claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				expectedLatestEventAt: null,
			}),
		).not.toBeNull();
	});
	it("prevents a normal resolver that rereads the resumed snapshot from claiming it", async () => {
		const f = await fixture();
		const run = await claimApprovedHomeDelegationResume(f.db, f.params);
		expect(run).not.toBeNull();
		expect(
			await compareAndTouchKernelRuntimeRun(f.db, {
				id: f.params.runId,
				organizationId: f.params.organizationId,
				status: "requires_approval",
				expectedUpdatedAt: run!.updatedAt,
				updatedAt: "2026-11-04T09:06:00.000Z",
				requireNoDelegationResumeClaim: true,
				delegationResolutionClaimId: "normal-fixture",
				delegationApprovalEventId: f.params.approvalEventId,
			}),
		).toBe(false);
	});
	it("does not resume after a normal resolver has claimed the observed run", async () => {
		const f = await fixture();
		expect(
			await compareAndTouchKernelRuntimeRun(f.db, {
				id: f.params.runId,
				organizationId: f.params.organizationId,
				status: "requires_approval",
				expectedUpdatedAt: f.params.expectedUpdatedAt,
				updatedAt: "2026-11-04T09:06:00.000Z",
				requireNoDelegationResumeClaim: true,
				delegationResolutionClaimId: "normal-fixture",
				delegationApprovalEventId: f.params.approvalEventId,
			}),
		).toBe(true);
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	});
	it("makes normal and resumed resolution mutually exclusive under concurrent calls", async () => {
		const f = await fixture();
		const [resume, normal] = await Promise.all([
			claimApprovedHomeDelegationResume(f.db, f.params),
			compareAndTouchKernelRuntimeRun(f.db, {
				id: f.params.runId,
				organizationId: f.params.organizationId,
				status: "requires_approval",
				expectedUpdatedAt: f.params.expectedUpdatedAt,
				updatedAt: "2026-11-04T09:06:00.000Z",
				requireNoDelegationResumeClaim: true,
				delegationResolutionClaimId: "normal-fixture",
				delegationApprovalEventId: f.params.approvalEventId,
			}),
		]);
		expect(Number(!!resume) + Number(normal)).toBe(1);
	});
	it("preserves default compare-and-touch behavior for other existing callers", async () => {
		const f = await fixture();
		await f.db
			.update(kernelRuntimeRuns)
			.set({
				metadata: sql`json_set(${kernelRuntimeRuns.metadata}, '$.homeDelegationResume', json('{}'))`,
			})
			.where(eq(kernelRuntimeRuns.id, f.params.runId));
		expect(
			await compareAndTouchKernelRuntimeRun(f.db, {
				id: f.params.runId,
				organizationId: f.params.organizationId,
				status: "requires_approval",
				expectedUpdatedAt: f.params.expectedUpdatedAt,
				updatedAt: "2026-11-04T09:06:00.000Z",
			}),
		).toBe(true);
	});
});

async function claimedFixture() {
	const f = await fixture();
	expect(
		await claimApprovedHomeDelegationResume(f.db, f.params),
	).not.toBeNull();
	const dispatch = {
		...f.params,
		targetTediId: "tedi-fixture",
		expectedChildRunId: "child-fixture",
	};
	const record = {
		...dispatch,
		outcome: "acknowledged" as const,
		observedChildRunId: "child-fixture",
		childConversationId: "child-conversation",
	};
	const abort = () =>
		f.db.insert(runtimeSubmissions).values({
			id: "submission-fixture",
			organizationId: f.params.organizationId,
			subjectKind: "kernel",
			subjectId: "kernel:org-fixture",
			runId: f.params.runId,
			conversationId: f.params.conversationId,
			sourceKind: "home",
			status: "running",
			abortRequestedAt: f.params.now,
		});
	return { ...f, dispatch, record, abort };
}

describe("recorded Home approval dispatch fence", () => {
	it("reserves only one actual concurrent send", async () => {
		const f = await claimedFixture();
		const results = await Promise.all([
			beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
			beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
	});
	it.each([
		["cancel", "UPDATE kernel_runtime_runs SET status='canceled'"],
		["Work version", "UPDATE work_items SET version=8"],
		[
			"Work specification",
			"UPDATE work_items SET admission_spec_revision='changed'",
		],
		[
			"claim",
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.homeDelegationResume.claimId','foreign')",
		],
		[
			"target",
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.homeDelegation.workOrder.targetTediId','foreign')",
		],
	])("denies send after changed %s", async (_name, statement) => {
		const f = await claimedFixture();
		f.sqlite.exec(statement);
		expect(
			await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
		).toBe(false);
	});
	it("denies send after durable abort before canceled status", async () => {
		const f = await claimedFixture();
		await f.abort();
		expect(
			await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
		).toBe(false);
	});
	it("records ACK and projects the exact child once without rewriting approval", async () => {
		const f = await claimedFixture();
		const receipts = await f.db.select().from(kernelRuntimeEvents);
		expect(
			await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
		).toBe(true);
		const result = await recordApprovedHomeDelegationResumeDispatch(
			f.db,
			f.record,
		);
		expect(result).toMatchObject({
			livePersisted: true,
			observationPersisted: true,
			run: {
				status: "queued",
				childRunId: "child-fixture",
				delegatedTediId: "tedi-fixture",
				childConversationId: "child-conversation",
				runtimeMetadata: { workItemId: "work-fixture" },
			},
		});
		expect(await f.db.select().from(kernelRuntimeEvents)).toEqual(receipts);
		const again = await recordApprovedHomeDelegationResumeDispatch(f.db, {
			...f.record,
			outcome: "failed",
			error: "late contradictory result",
		});
		expect(again).toMatchObject({
			livePersisted: false,
			observationPersisted: false,
		});
		expect(again.run).toEqual(result.run);
	});
	it.each([
		["canceled", "UPDATE kernel_runtime_runs SET status='canceled'"],
		["completed", "UPDATE kernel_runtime_runs SET status='completed'"],
		["Work version", "UPDATE work_items SET version=8"],
		[
			"Work specification",
			"UPDATE work_items SET admission_spec_revision='changed'",
		],
	])(
		"retains actual late ACK without reviving after %s",
		async (name, statement) => {
			const f = await claimedFixture();
			await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
			f.sqlite.exec(statement);
			const result = await recordApprovedHomeDelegationResumeDispatch(
				f.db,
				f.record,
			);
			expect(result).toMatchObject({
				livePersisted: false,
				observationPersisted: true,
				run: {
					status:
						name === "canceled" || name === "completed"
							? name
							: "requires_approval",
					childRunId: null,
					metadata: {
						keep: "untouched",
						homeDelegationResume: {
							phase: "observed",
							observation: {
								outcome: "acknowledged",
								observedChildRunId: "child-fixture",
							},
						},
					},
				},
			});
		},
	);
	it("retains ACK after durable abort before parent status patch", async () => {
		const f = await claimedFixture();
		await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
		await f.abort();
		expect(
			await recordApprovedHomeDelegationResumeDispatch(f.db, f.record),
		).toMatchObject({
			livePersisted: false,
			observationPersisted: true,
			run: { status: "requires_approval", childRunId: null },
		});
	});
	it.each(["unknown", "mismatched ACK"] as const)(
		"locks %s without dropping actual response or granting custody",
		async (kind) => {
			const f = await claimedFixture();
			await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
			const result = await recordApprovedHomeDelegationResumeDispatch(f.db, {
				...f.record,
				...(kind === "unknown"
					? { outcome: "unknown" as const, observedChildRunId: null }
					: { observedChildRunId: "different-child" }),
				error: "x".repeat(1200),
			});
			expect(result).toMatchObject({
				livePersisted: false,
				observationPersisted: true,
				run: {
					status: "requires_approval",
					childRunId: null,
					metadata: {
						homeDelegationResume: {
							phase: "observed",
							observation: {
								outcome: "unknown",
								observedChildRunId:
									kind === "unknown" ? null : "different-child",
								error: "x".repeat(1000),
							},
						},
					},
				},
			});
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch),
			).toBe(false);
		},
	);
	it("records explicit failed delivery only while parent remains live", async () => {
		const f = await claimedFixture();
		await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
		expect(
			await recordApprovedHomeDelegationResumeDispatch(f.db, {
				...f.record,
				outcome: "failed",
				observedChildRunId: null,
			}),
		).toMatchObject({
			livePersisted: true,
			observationPersisted: true,
			run: { status: "failed", completedAt: f.params.now, childRunId: null },
		});
	});
});

it("accepts only one concurrent delivery observation and physical projection", async () => {
	const f = await claimedFixture();
	await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
	const results = await Promise.all([
		recordApprovedHomeDelegationResumeDispatch(f.db, f.record),
		recordApprovedHomeDelegationResumeDispatch(f.db, {
			...f.record,
			outcome: "failed",
			observedChildRunId: null,
		}),
	]);
	expect(results.filter((r) => r.observationPersisted)).toHaveLength(1);
	expect(results.filter((r) => r.livePersisted)).toHaveLength(1);
});
it("retains ACK without overwriting an independently linked child conversation", async () => {
	const f = await claimedFixture();
	await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
	await f.db
		.update(kernelRuntimeRuns)
		.set({ childConversationId: "other-conversation" });
	expect(
		await recordApprovedHomeDelegationResumeDispatch(f.db, f.record),
	).toMatchObject({
		observationPersisted: true,
		livePersisted: false,
		run: {
			status: "requires_approval",
			childConversationId: "other-conversation",
			childRunId: null,
		},
	});
});

it("denies resume after a fresh reread of an in-flight normal resolution", async () => {
	const f = await fixture();
	const originalExpiresAt = "2026-11-05T09:00:00.000Z";
	f.params.expectedMetadata = {
		...f.params.expectedMetadata,
		homeDelegation: {
			...(f.params.expectedMetadata.homeDelegation as object),
			expiresAt: originalExpiresAt,
		},
	};
	await f.db
		.update(kernelRuntimeRuns)
		.set({ metadata: f.params.expectedMetadata });
	expect(
		await compareAndTouchKernelRuntimeRun(f.db, {
			id: f.params.runId,
			organizationId: f.params.organizationId,
			status: "requires_approval",
			expectedUpdatedAt: f.params.expectedUpdatedAt,
			updatedAt: f.params.now,
			requireNoDelegationResumeClaim: true,
			delegationResolutionClaimId: "normal-owner",
			delegationApprovalEventId: "normal-new-event",
		}),
	).toBe(true);
	const fresh = await f.read();
	expect(
		await claimApprovedHomeDelegationResume(f.db, {
			...f.params,
			expectedUpdatedAt: fresh!.updatedAt,
			expectedMetadata: fresh!.metadata!,
		}),
	).toBeNull();
	expect(
		await markHomeDelegationResolutionAdmissionFailed(f.db, {
			organizationId: f.params.organizationId,
			runId: f.params.runId,
			expectedClaimId: "foreign-owner",
			now: f.params.now,
		}),
	).toBe(false);
	const [original] = await f.db.select().from(kernelRuntimeEvents);
	await f.db
		.insert(kernelRuntimeEvents)
		.values({ ...original!, id: "normal-new-event", createdAt: f.params.now });
	f.params.approvalEventId = "normal-new-event";
	f.params.approvalResolvedAt = f.params.now;
	expect(
		await claimApprovedHomeDelegationResume(f.db, {
			...f.params,
			expectedUpdatedAt: fresh!.updatedAt,
			expectedMetadata: fresh!.metadata!,
		}),
	).toBeNull();

	expect(
		await markHomeDelegationResolutionAdmissionFailed(f.db, {
			organizationId: f.params.organizationId,
			runId: f.params.runId,
			expectedClaimId: "normal-owner",
			now: f.params.now,
		}),
	).toBe(true);
	const retired = await f.read();
	expect(retired!.updatedAt).toBe(f.params.now);
	expect(
		await claimApprovedHomeDelegationResume(f.db, {
			...f.params,
			expectedUpdatedAt: retired!.updatedAt,
			expectedMetadata: retired!.metadata!,
		}),
	).toBeNull();
	const events = (await f.db.select().from(kernelRuntimeEvents)).sort(
		(a, b) =>
			a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
	);
	expect(events).toHaveLength(2);
	expect(
		await claimApprovedHomeDelegationResume(f.db, {
			...f.params,
			expectedUpdatedAt: retired!.updatedAt,
			expectedMetadata: retired!.metadata!,
			approvalEventSet: { digest: "b".repeat(64), originalExpiresAt, events },
		}),
	).not.toBeNull();
});
it.each(["unscoped", "scoped", "transition"] as const)(
	"preserves trusted resume proof during %s stale cancellation and late ACK",
	async (kind) => {
		const f = await claimedFixture();
		const stale = f.params.expectedMetadata;
		await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
		const patch = {
			status: "canceled" as const,
			metadata: { ...stale, homeDelegationResume: { claimId: "injected" } },
		};
		if (kind === "unscoped")
			await updateKernelRuntimeRun(f.db, f.params.runId, patch);
		else if (kind === "scoped")
			await updateKernelRuntimeRunForOrg(f.db, {
				id: f.params.runId,
				organizationId: f.params.organizationId,
				patch,
			});
		else
			expect(
				await transitionKernelRuntimeRunStatus(f.db, {
					id: f.params.runId,
					organizationId: f.params.organizationId,
					fromStatus: "requires_approval",
					patch,
				}),
			).toBe(true);
		expect(
			await recordApprovedHomeDelegationResumeDispatch(f.db, f.record),
		).toMatchObject({
			observationPersisted: true,
			livePersisted: false,
			run: {
				status: "canceled",
				metadata: {
					homeDelegationResume: {
						claimId: f.params.claimId,
						phase: "observed",
						observation: { observedChildRunId: "child-fixture" },
					},
				},
			},
		});
	},
);
it("strips caller-injected reserved claims when no trusted claim exists", async () => {
	const f = await fixture();
	await updateKernelRuntimeRun(f.db, f.params.runId, {
		metadata: {
			keep: "safe",
			homeDelegationResume: { claimId: "fake" },
			homeDelegationResolutionClaim: { claimId: "fake" },
		},
	});
	expect((await f.read())!.metadata).toEqual({ keep: "safe" });
});

it.each(["running", "expired"] as const)(
	"refuses historical same-child %s Attempt even without parent child link",
	async (state) => {
		const f = await fixture();
		await f.db.insert(workAttempts).values({
			id: "historical-attempt",
			orgId: f.params.organizationId,
			workItemId: f.params.workItemId,
			executorType: "tedi",
			executorId: f.params.targetTediId,
			runId: f.params.expectedChildRunId,
			attemptNumber: 1,
			runtimeState: state,
			startedAt: f.params.now,
			heartbeatAt: f.params.now,
			...(state === "expired"
				? { outcome: "expired" as const, finishedAt: f.params.now }
				: {}),
		});
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	},
);
it("refuses an indexed known child dispatch receipt", async () => {
	const f = await fixture();
	await f.db.insert(chatDispatchIdempotency).values({
		idempotencyKey: "child-delivery",
		tediId: f.params.targetTediId,
		organizationId: f.params.organizationId,
		conversationId: "child-conversation",
		runId: f.params.expectedChildRunId,
	});
	expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
});
it("refuses an indexed known runtime child submission", async () => {
	const f = await fixture();
	await f.db.insert(runtimeSubmissions).values({
		id: "child-submission",
		organizationId: f.params.organizationId,
		subjectKind: "tedi",
		subjectId: f.params.targetTediId,
		runId: f.params.expectedChildRunId,
		conversationId: "child-conversation",
		sourceKind: "home",
		status: "queued",
	});
	expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
});
it.each(["target", "Work"] as const)(
	"refuses canonical approval %s retargeting",
	async (kind) => {
		const f = await fixture();
		await f.db.update(kernelRuntimeEvents).set({
			payload: sql`json_set(${kernelRuntimeEvents.payload}, ${kind === "target" ? "$.delegationWorkOrder.targetTediId" : "$.delegationWorkOrder.workItemId"}, 'foreign')`,
		});
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	},
);
it("projects a canonical legacy null actor without inventing attribution", async () => {
	const f = await fixture();
	await f.db.update(kernelRuntimeEvents).set({
		payload: sql`json_set(${kernelRuntimeEvents.payload}, '$.resolvedBy', null, '$.resolution', 'Original decision')`,
	});
	expect(
		(await claimApprovedHomeDelegationResume(f.db, f.params))?.metadata,
	).toMatchObject({
		homeDelegation: {
			resolvedBy: null,
			resolution: "Original decision",
			resolvedAt: f.params.approvalResolvedAt,
		},
	});
});
it("parses persisted proof but refuses partial or malformed scope", async () => {
	const f = await claimedFixture();
	const run = await f.read();
	const scope = {
		organizationId: f.params.organizationId,
		runId: f.params.runId,
		conversationId: f.params.conversationId,
		metadata: run!.metadata,
	};
	expect(parseApprovedHomeDelegationResumeScope(scope)).toMatchObject({
		claimId: f.params.claimId,
		targetTediId: f.params.targetTediId,
		expectedChildRunId: f.params.expectedChildRunId,
	});
	expect(
		parseApprovedHomeDelegationResumeScope({
			...scope,
			metadata: { homeDelegationResume: { version: 1 } },
		}),
	).toBeNull();
	expect(
		parseApprovedHomeDelegationResumeScope({ ...scope, metadata: null }),
	).toBeNull();
});
it("keeps normal ownership during stale metadata cancellation and refuses release after abort", async () => {
	const f = await fixture();
	expect(
		await compareAndTouchKernelRuntimeRun(f.db, {
			id: f.params.runId,
			organizationId: f.params.organizationId,
			status: "requires_approval",
			expectedUpdatedAt: f.params.expectedUpdatedAt,
			updatedAt: f.params.now,
			requireNoDelegationResumeClaim: true,
			delegationResolutionClaimId: "normal-owner",
			delegationApprovalEventId: f.params.approvalEventId,
		}),
	).toBe(true);
	await updateKernelRuntimeRun(f.db, f.params.runId, {
		metadata: f.params.expectedMetadata,
	});
	expect((await f.read())!.metadata).toMatchObject({
		homeDelegationResolutionClaim: {
			claimId: "normal-owner",
			phase: "resolving",
		},
	});
	await f.db.insert(runtimeSubmissions).values({
		id: "aborted-parent",
		organizationId: f.params.organizationId,
		subjectKind: "kernel",
		subjectId: "kernel:fixture",
		runId: f.params.runId,
		conversationId: f.params.conversationId,
		sourceKind: "home",
		status: "running",
		abortRequestedAt: f.params.now,
	});
	expect(
		await markHomeDelegationResolutionAdmissionFailed(f.db, {
			organizationId: f.params.organizationId,
			runId: f.params.runId,
			expectedClaimId: "normal-owner",
			now: f.params.now,
		}),
	).toBe(false);
});

it.each([
	["version", 2],
	["approvalEventId", "missing-event"],
	["approvalResolvedAt", "2026-11-04T08:00:00.000Z"],
	["conversationId", "foreign-conversation"],
	["workItemId", "foreign-work"],
	["scopeDigest", "foreign-scope"],
	["claimId", ""],
] as const)(
	"rejects spoofed admission_failed normal marker %s",
	async (key, value) => {
		const f = await fixture();
		const marker = {
			version: 1,
			phase: "admission_failed",
			claimId: "normal-owner",
			approvalEventId: f.params.approvalEventId,
			approvalResolvedAt: f.params.approvalResolvedAt,
			organizationId: f.params.organizationId,
			runId: f.params.runId,
			conversationId: f.params.conversationId,
			workItemId: f.params.workItemId,
			scopeDigest: f.params.scopeDigest,
			[key]: value,
		};
		const metadata = {
			...f.params.expectedMetadata,
			homeDelegationResolutionClaim: marker,
		};
		await f.db.update(kernelRuntimeRuns).set({ metadata });
		expect(
			await claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				expectedMetadata: metadata,
			}),
		).toBeNull();
	},
);

it.each(["live", "canceled", "aborted"] as const)(
	"retains one actual late ACK after timeout while parent is %s",
	async (kind) => {
		const f = await claimedFixture();
		await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
		const unknown = await recordApprovedHomeDelegationResumeDispatch(f.db, {
			...f.record,
			outcome: "unknown",
			observedChildRunId: null,
		});
		const original = (
			unknown.run!.metadata!.homeDelegationResume as Record<string, unknown>
		).observation;
		if (kind === "canceled")
			await updateKernelRuntimeRun(f.db, f.params.runId, {
				status: "canceled",
				metadata: f.params.expectedMetadata,
			});
		if (kind === "aborted") await f.abort();
		const late = await recordApprovedHomeDelegationResumeDispatch(
			f.db,
			f.record,
		);
		expect(late.observationPersisted).toBe(true);
		expect(late.livePersisted).toBe(kind === "live");
		expect(late.run).toMatchObject({
			status:
				kind === "live"
					? "queued"
					: kind === "canceled"
						? "canceled"
						: "requires_approval",
			childRunId: kind === "live" ? "child-fixture" : null,
			metadata: {
				homeDelegationResume: {
					observation: original,
					lateObservation: {
						outcome: "acknowledged",
						observedChildRunId: "child-fixture",
					},
				},
			},
		});
		const duplicate = await recordApprovedHomeDelegationResumeDispatch(f.db, {
			...f.record,
			error: "duplicate",
		});
		expect(duplicate).toMatchObject({
			livePersisted: false,
			observationPersisted: false,
			run: late.run,
		});
	},
);

it.each(["initial", "late"] as const)(
	"records one stop for canceled parent exact %s ACK without revival",
	async (kind) => {
		const f = await claimedFixture();
		await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
		if (kind === "late")
			await recordApprovedHomeDelegationResumeDispatch(f.db, {
				...f.record,
				outcome: "unknown",
				observedChildRunId: null,
			});
		await updateKernelRuntimeRun(f.db, f.params.runId, {
			status: "canceled",
			metadata: f.params.expectedMetadata,
		});
		await recordApprovedHomeDelegationResumeDispatch(f.db, f.record);
		const stop = {
			...f.dispatch,
			stopAttemptId: "stop-fixture",
			outcome: "attempted" as const,
		};
		const attempts = await Promise.all([
			recordApprovedHomeDelegationResumeStopOutcome(f.db, stop),
			recordApprovedHomeDelegationResumeStopOutcome(f.db, {
				...stop,
				stopAttemptId: "other-stop",
			}),
		]);
		expect(attempts.filter(Boolean)).toHaveLength(1);
		const afterAttempt = await f.read();
		const owner = (
			afterAttempt!.metadata!.homeDelegationResume as Record<string, unknown>
		).stopObservation as { attemptId: string };
		expect(
			await recordApprovedHomeDelegationResumeStopOutcome(f.db, {
				...stop,
				stopAttemptId: "foreign-stop",
				outcome: "succeeded",
			}),
		).toBe(false);
		expect(
			await recordApprovedHomeDelegationResumeStopOutcome(f.db, {
				...stop,
				stopAttemptId: owner.attemptId,
				outcome: "unknown",
				error: "x".repeat(1200),
			}),
		).toBe(true);
		const completed = await f.read();
		expect(completed).toMatchObject({
			status: "canceled",
			childRunId: null,
			metadata: {
				homeDelegationResume: {
					stopObservation: {
						attemptId: owner.attemptId,
						completion: { outcome: "unknown", error: "x".repeat(1000) },
					},
				},
			},
		});
		expect(
			await recordApprovedHomeDelegationResumeStopOutcome(f.db, {
				...stop,
				stopAttemptId: owner.attemptId,
				outcome: "succeeded",
			}),
		).toBe(false);
		expect(await f.read()).toEqual(completed);
	},
);
it("requires abort intent or canceled status before stop reservation", async () => {
	const f = await claimedFixture();
	await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
	await recordApprovedHomeDelegationResumeDispatch(f.db, f.record);
	const stop = {
		...f.dispatch,
		stopAttemptId: "stop-fixture",
		outcome: "attempted" as const,
	};
	expect(await recordApprovedHomeDelegationResumeStopOutcome(f.db, stop)).toBe(
		false,
	);
	await f.abort();
	expect(await recordApprovedHomeDelegationResumeStopOutcome(f.db, stop)).toBe(
		true,
	);
});
it.each([
	"no ACK",
	"mismatched ACK",
	"foreign child",
	"foreign target",
	"foreign claim",
] as const)("denies stop for %s", async (kind) => {
	const f = await claimedFixture();
	await beginApprovedHomeDelegationResumeDispatch(f.db, f.dispatch);
	if (kind !== "no ACK")
		await recordApprovedHomeDelegationResumeDispatch(f.db, {
			...f.record,
			...(kind === "mismatched ACK" ? { observedChildRunId: "foreign" } : {}),
		});
	await updateKernelRuntimeRun(f.db, f.params.runId, { status: "canceled" });
	expect(
		await recordApprovedHomeDelegationResumeStopOutcome(f.db, {
			...f.dispatch,
			stopAttemptId: "stop-fixture",
			outcome: "attempted",
			...(kind === "foreign child"
				? { expectedChildRunId: "foreign" }
				: kind === "foreign target"
					? { targetTediId: "foreign" }
					: kind === "foreign claim"
						? { claimId: "foreign" }
						: {}),
		}),
	).toBe(false);
});

it.each(["running", "expired"] as const)(
	"refuses same target/child %s Attempt on another Work",
	async (state) => {
		const f = await fixture();
		await f.db.insert(workItems).values({
			id: "other-work",
			orgId: f.params.organizationId,
			title: "Earlier Work",
			disposition: "accepted",
			version: 1,
			admissionSpecRevision: "other-spec",
			createdAt: f.params.now,
			updatedAt: f.params.now,
		});
		await f.db.insert(workAttempts).values({
			id: "other-work-attempt",
			orgId: f.params.organizationId,
			workItemId: "other-work",
			executorType: "tedi",
			executorId: f.params.targetTediId,
			runId: f.params.expectedChildRunId,
			attemptNumber: 1,
			runtimeState: state,
			startedAt: f.params.now,
			heartbeatAt: f.params.now,
			...(state === "expired"
				? { outcome: "expired" as const, finishedAt: f.params.now }
				: {}),
		});
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	},
);
it("uses the existing scoped executor index for cross-Work child history", async () => {
	const f = await fixture();
	const plan = f.sqlite
		.prepare(
			"EXPLAIN QUERY PLAN SELECT id FROM work_attempts WHERE org_id=? AND executor_type=? AND executor_id=? AND run_id=?",
		)
		.all(
			f.params.organizationId,
			"tedi",
			f.params.targetTediId,
			f.params.expectedChildRunId,
		);
	expect(JSON.stringify(plan)).toContain("idx_work_attempt_executor_state");
	expect(JSON.stringify(plan)).not.toContain("SCAN work_attempts");
});

async function approvalSetFixture(count = 4) {
	const f = await fixture();
	const original = (await f.db.select().from(kernelRuntimeEvents))[0]!;
	const expiresAt = "2026-11-05T09:00:00.000Z";
	f.params.expectedMetadata = {
		...f.params.expectedMetadata,
		homeDelegation: {
			...(f.params.expectedMetadata.homeDelegation as object),
			expiresAt,
		},
	};
	await f.db.delete(kernelRuntimeEvents);
	const events = Array.from({ length: count }, (_, i) => ({
		...original,
		id: `approval-${i}`,
		createdAt: `2026-11-04T09:0${i}:00.000Z`,
		delegatedTediId: f.params.targetTediId,
		payload: { ...original.payload!, resolvedBy: null, resolution: null },
		runtimeMetadata: {
			source: "kernelRuntime.respondApproval",
			dispatch: "home-delegation-approved",
		},
	}));
	for (const event of events)
		await f.db.insert(kernelRuntimeEvents).values(event);
	const latest = events.at(-1)!;
	f.params.approvalEventId = latest.id;
	f.params.approvalResolvedAt = latest.createdAt;
	f.params.expectedUpdatedAt = latest.createdAt;
	f.params.expectedLatestEventAt = latest.createdAt;
	f.params.approvalEventSet = {
		digest: "b".repeat(64),
		originalExpiresAt: expiresAt,
		events,
	};
	await f.db.update(kernelRuntimeRuns).set({
		metadata: f.params.expectedMetadata,
		updatedAt: latest.createdAt,
		latestEventAt: latest.createdAt,
	});
	return f;
}

describe("complete historical approval event set", () => {
	it.each([2, 4, 8])(
		"freezes %i full receipts and preserves null actors through one send",
		async (count) => {
			const f = await approvalSetFixture(count);
			const before = await f.db.select().from(kernelRuntimeEvents);
			const claimed = await claimApprovedHomeDelegationResume(f.db, f.params);
			expect(claimed).not.toBeNull();
			expect(claimed?.metadata?.homeDelegationResume).toMatchObject({
				approvalEventSet: f.params.approvalEventSet,
				scopeDigest: f.params.scopeDigest,
			});
			expect(claimed?.metadata?.homeDelegation).toMatchObject({
				resolvedBy: null,
			});
			const scope = parseApprovedHomeDelegationResumeScope({
				...f.params,
				metadata: claimed!.metadata,
			});
			expect(scope?.approvalEventSet).toEqual(f.params.approvalEventSet);
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, {
					...scope!,
					now: f.params.now,
				}),
			).toBe(true);
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, {
					...scope!,
					now: f.params.now,
				}),
			).toBe(false);
			expect(await f.db.select().from(kernelRuntimeEvents)).toEqual(before);
		},
	);

	const mutations = [
		[
			"appended approval",
			"INSERT INTO kernel_runtime_events (id,organization_id,conversation_id,run_id,kind,created_at,payload) SELECT 'new-approval',organization_id,conversation_id,run_id,kind,created_at,payload FROM kernel_runtime_events LIMIT 1",
		],
		[
			"deleted receipt",
			"DELETE FROM kernel_runtime_events WHERE id='approval-0'",
		],
		[
			"changed payload",
			"UPDATE kernel_runtime_events SET payload=json_set(payload,'$.resolution','changed') WHERE id='approval-0'",
		],
		[
			"rejection",
			"UPDATE kernel_runtime_events SET payload=json_set(payload,'$.status','rejected') WHERE id='approval-0'",
		],
		[
			"changed actor",
			'UPDATE kernel_runtime_events SET payload=json_set(payload,\'$.resolvedBy\',json(\'{"type":"user","id":"different"}\')) WHERE id=\'approval-0\'',
		],
		[
			"changed producer",
			"UPDATE kernel_runtime_events SET runtime_metadata=json_set(runtime_metadata,'$.source','different') WHERE id='approval-0'",
		],
		[
			"changed receipt time",
			"UPDATE kernel_runtime_events SET created_at='2026-11-04T09:00:01.000Z' WHERE id='approval-0'",
		],
		[
			"changed target",
			"UPDATE kernel_runtime_events SET delegated_tedi_id='different' WHERE id='approval-0'",
		],
		[
			"changed backend",
			"UPDATE kernel_runtime_events SET runtime_backend='cloudflare' WHERE id='approval-0'",
		],
		[
			"changed nullable trace",
			"UPDATE kernel_runtime_events SET trace_id='new-trace' WHERE id='approval-0'",
		],
		[
			"changed conversation",
			"UPDATE kernel_runtime_events SET conversation_id='different' WHERE id='approval-0'",
		],
		[
			"changed hold",
			"UPDATE kernel_runtime_runs SET metadata=json_set(metadata,'$.homeDelegation.expiresAt','2026-11-06T09:00:00.000Z')",
		],
	] as const;
	it.each(mutations)(
		"refuses %s between read and claim",
		async (_, statement) => {
			const f = await approvalSetFixture();
			f.sqlite.exec(statement);
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).toBeNull();
		},
	);
	it.each(mutations)(
		"refuses %s between claim and send",
		async (_, statement) => {
			const f = await approvalSetFixture();
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).not.toBeNull();
			f.sqlite.exec(statement);
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, f.params),
			).toBe(false);
			expect((await f.read())?.metadata?.homeDelegationResume).toMatchObject({
				phase: "claimed",
			});
		},
	);
	it("allows only one actual claimant of the same complete event set", async () => {
		const f = await approvalSetFixture();
		const claims = await Promise.all([
			claimApprovedHomeDelegationResume(f.db, f.params),
			claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				claimId: "second",
			}),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
	});
	it("refuses expiry crossing between claim and send", async () => {
		const f = await approvalSetFixture();
		expect(
			await claimApprovedHomeDelegationResume(f.db, f.params),
		).not.toBeNull();
		expect(
			await beginApprovedHomeDelegationResumeDispatch(f.db, {
				...f.params,
				now: f.params.approvalEventSet!.originalExpiresAt,
			}),
		).toBe(false);
	});
	it("refuses an already expired original hold even when the snapshot is unchanged", async () => {
		const f = await approvalSetFixture();
		expect(
			await claimApprovedHomeDelegationResume(f.db, {
				...f.params,
				now: f.params.approvalEventSet!.originalExpiresAt,
			}),
		).toBeNull();
	});
	it.each(["missing", "reversed", "duplicate", "digest", "anchor"])(
		"refuses %s set proof at the send boundary",
		async (kind) => {
			const f = await approvalSetFixture();
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).not.toBeNull();
			const proof = structuredClone(f.params.approvalEventSet!);
			if (kind === "reversed") proof.events.reverse();
			if (kind === "duplicate") proof.events[0] = proof.events[1]!;
			if (kind === "digest") proof.digest = "c".repeat(64);
			if (kind === "anchor") proof.events.pop();
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, {
					...f.params,
					approvalEventSet: kind === "missing" ? undefined : proof,
				}),
			).toBe(false);
		},
	);
	it.each([
		"one",
		"nine",
		"duplicate",
		"reversed",
		"missing nullable field",
		"snapshot payload",
		"latest anchor",
	])("refuses %s proof before claim", async (kind) => {
		const f = await approvalSetFixture();
		const proof = f.params.approvalEventSet!;
		if (kind === "one") proof.events = proof.events.slice(-1);
		if (kind === "nine")
			proof.events = Array.from({ length: 9 }, (_, i) => ({
				...proof.events[0]!,
				id: `receipt-${i}`,
			}));
		if (kind === "duplicate") proof.events[0] = proof.events[1]!;
		if (kind === "reversed") proof.events.reverse();
		if (kind === "missing nullable field")
			Reflect.deleteProperty(proof.events[0]!, "traceId");
		if (kind === "snapshot payload")
			proof.events[0]!.payload = {
				...proof.events[0]!.payload,
				resolution: "forged",
			};
		if (kind === "latest anchor")
			f.params.approvalEventId = proof.events[0]!.id;
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	});
	it("compares the original expiry as an instant rather than local clock text", async () => {
		const f = await approvalSetFixture();
		const expiry = "2026-11-04T09:06:00.000+02:00";
		f.params.approvalEventSet!.originalExpiresAt = expiry;
		(
			f.params.expectedMetadata.homeDelegation as Record<string, unknown>
		).expiresAt = expiry;
		await f.db
			.update(kernelRuntimeRuns)
			.set({ metadata: f.params.expectedMetadata });
		expect(await claimApprovedHomeDelegationResume(f.db, f.params)).toBeNull();
	});
	it("keeps scoped index lookup for the complete event history", async () => {
		const f = await approvalSetFixture();
		const plan = f.sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT count(*) FROM kernel_runtime_events WHERE organization_id=? AND run_id=? AND kind='approval.resolved'",
			)
			.all(f.params.organizationId, f.params.runId);
		expect(JSON.stringify(plan)).toContain(
			"idx_kernel_runtime_events_run_created",
		);
		expect(JSON.stringify(plan)).not.toContain("SCAN kernel_runtime_events");
	});
});

it.each(["claim", "send"])(
	"refuses an approval appended before the unique-mode %s boundary",
	async (boundary) => {
		const f = await fixture();
		const snapshot = (await f.db.select().from(kernelRuntimeEvents))[0]!;
		if (boundary === "send")
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).not.toBeNull();
		await f.db.insert(kernelRuntimeEvents).values({
			...snapshot,
			id: "second-approval",
			createdAt: "2026-11-04T09:01:00.000Z",
		});
		if (boundary === "claim")
			expect(
				await claimApprovedHomeDelegationResume(f.db, f.params),
			).toBeNull();
		else {
			expect(
				await beginApprovedHomeDelegationResumeDispatch(f.db, f.params),
			).toBe(false);
			expect((await f.read())?.metadata?.homeDelegationResume).toMatchObject({
				phase: "claimed",
			});
		}
	},
);
