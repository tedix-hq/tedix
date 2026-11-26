import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	chatDispatchIdempotency,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { organizations } from "../schema/organizations";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import { tedis } from "../schema/tedis";
import { workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	beginApprovedHomeDelegationResumeDispatch,
	claimApprovedHomeDelegationResume,
	compareAndTouchKernelRuntimeRun,
	countActiveDelegatedRunsByTedi,
	findKernelRuntimeRunByChild,
	findKernelRuntimeRunForOutputRevision,
	getDurableKernelRuntimeRun,
	getKernelRuntimeRun,
	getKernelRuntimeRunStatus,
	hasUnacceptedChatDispatch,
	insertKernelRuntimeRunIfAbsent,
	listKernelRuntimeRunMetadata,
	listKernelRuntimeRunObjectiveSourcesByIds,
	listKernelRuntimeRuns,
	listPendingDelegationRuns,
	listQuietDelegatedRuns,
	readLatestRunAwaitingDelegationApproval,
	readPendingWorkflowHint,
	recordApprovedHomeDelegationResumeDispatch,
	recordApprovedHomeDelegationResumeStopOutcome,
	transitionKernelRuntimeRunStatus,
	updateKernelRuntimeRun,
	updateKernelRuntimeRunForOrg,
	type ClaimApprovedHomeDelegationResumeParams,
} from "./kernel-runtime-runs";

const at = "2026-11-20T12:00:00.000Z";
const later = "2026-11-20T12:05:00.000Z";
const stores = ["d1", "postgres"] as const;

for (const store of stores) {
	describe(`lane 9a kernel runtime runs: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, tedis)).values([
				{
					id: "tedi-1",
					organizationId: "org",
					name: "Tedi",
					slug: "tedi-1",
				},
				{
					id: "tedi-2",
					organizationId: "org",
					name: "Tedi two",
					slug: "tedi-2",
				},
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("reads runs through stored columns, lists and id lookups", async () => {
			const runs = coreTable(db, kernelRuntimeRuns);
			await db.insert(runs).values([
				{
					id: "run-pending",
					organizationId: "org",
					conversationId: "conv-1",
					status: "requires_approval",
					createdAt: at,
					updatedAt: at,
					latestEventAt: at,
					metadata: {
						homeDelegation: {
							decision: { mode: "needs_approval" },
							workOrder: {
								targetTediId: "tedi-1",
								objective: "Ship the thing",
							},
						},
					},
					runtimeMetadata: { note: "pending" },
				},
				{
					id: "run-child",
					organizationId: "org",
					conversationId: "conv-1",
					status: "queued",
					delegatedTediId: "tedi-1",
					childRunId: "child-1",
					childConversationId: "child-conv",
					startedAt: "2026-11-19T00:00:00.000Z",
					createdAt: "2026-11-19T00:00:00.000Z",
					updatedAt: "2026-11-19T00:00:00.000Z",
					preview: "delegated",
				},
				{
					id: "run-other",
					organizationId: "other",
					conversationId: "conv-x",
					status: "completed",
					createdAt: at,
					updatedAt: at,
				},
			]);

			expect(
				await getKernelRuntimeRunStatus(db, {
					id: "run-pending",
					organizationId: "org",
				}),
			).toBe("requires_approval");
			expect(
				await getKernelRuntimeRun(db, {
					id: "run-pending",
					organizationId: "other",
				}),
			).toBeUndefined();
			const pending = await getKernelRuntimeRun(db, {
				id: "run-pending",
				organizationId: "org",
			});
			expect(pending?.status).toBe("requires_approval");
			expect(pending).not.toHaveProperty("workItemId");
			expect(pending).not.toHaveProperty("targetTediId");

			const listed = await listKernelRuntimeRuns(db, {
				organizationId: "org",
				limit: 10,
				orderBy: "created",
			});
			expect(listed.map((row) => row.id).sort()).toEqual([
				"run-child",
				"run-pending",
			]);
			expect(
				(
					await listKernelRuntimeRuns(db, {
						organizationId: "org",
						conversationId: "conv-1",
						childRunIds: ["child-1"],
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["run-child"]);
			expect(
				await listKernelRuntimeRuns(db, {
					organizationId: "org",
					childRunIds: [],
					limit: 10,
				}),
			).toEqual([]);

			expect(
				await listKernelRuntimeRunMetadata(db, {
					organizationId: "org",
					conversationId: "conv-1",
					limit: 10,
				}),
			).toHaveLength(2);
			expect(
				(
					await listKernelRuntimeRunObjectiveSourcesByIds(db, {
						organizationId: "org",
						ids: ["run-pending", "run-child", "run-pending"],
					})
				).map((row) => row.id),
			).toEqual(expect.arrayContaining(["run-pending", "run-child"]));
			expect(
				await findKernelRuntimeRunByChild(db, {
					organizationId: "org",
					delegatedTediId: "tedi-1",
					childRunId: "child-1",
				}),
			).toMatchObject({ id: "run-child" });
			expect(
				await getDurableKernelRuntimeRun(db, {
					id: "run-child",
					organizationId: "org",
					delegatedTediId: "tedi-1",
					childRunId: "child-1",
				}),
			).toMatchObject({ id: "run-child" });
		});

		it("writes runs idempotently and preserves delegation claims on metadata patches", async () => {
			const runs = coreTable(db, kernelRuntimeRuns);
			const value = {
				id: "run-ifabsent",
				organizationId: "org",
				conversationId: "conv-1",
				status: "queued" as const,
				createdAt: at,
				updatedAt: at,
				metadata: { homeDelegationResume: { version: 1, phase: "claimed" } },
			};
			await insertKernelRuntimeRunIfAbsent(db, value);
			await insertKernelRuntimeRunIfAbsent(db, {
				...value,
				preview: "ignored",
			});
			expect(
				(await getKernelRuntimeRun(db, { id: "run-ifabsent" }))?.preview,
			).toBeNull();

			await updateKernelRuntimeRun(db, "run-ifabsent", {
				preview: "patched",
				metadata: { homeDelegation: { note: "rewritten" } },
			});
			const patched = await getKernelRuntimeRun(db, {
				id: "run-ifabsent",
				organizationId: "org",
			});
			expect(patched?.preview).toBe("patched");
			expect(patched?.metadata).toMatchObject({
				homeDelegation: { note: "rewritten" },
				homeDelegationResume: { version: 1, phase: "claimed" },
			});

			await updateKernelRuntimeRunForOrg(db, {
				id: "run-ifabsent",
				organizationId: "org",
				patch: { status: "running" },
			});
			expect(
				await getKernelRuntimeRunStatus(db, {
					id: "run-ifabsent",
					organizationId: "org",
				}),
			).toBe("running");
			await updateKernelRuntimeRunForOrg(db, {
				id: "run-ifabsent",
				organizationId: "other",
				patch: { status: "failed" },
			});
			expect(
				await getKernelRuntimeRunStatus(db, {
					id: "run-ifabsent",
					organizationId: "org",
				}),
			).toBe("running");
		});

		it("guards status transitions and delegation-resolution claims", async () => {
			const runs = coreTable(db, kernelRuntimeRuns);
			await db.insert(runs).values({
				id: "run-cas",
				organizationId: "org",
				conversationId: "conv-1",
				status: "requires_approval",
				createdAt: at,
				updatedAt: at,
			});
			expect(
				await transitionKernelRuntimeRunStatus(db, {
					id: "run-cas",
					organizationId: "org",
					fromStatus: "requires_approval",
					expectedUpdatedAt: at,
					patch: { status: "failed", updatedAt: later },
				}),
			).toBe(true);
			expect(
				await transitionKernelRuntimeRunStatus(db, {
					id: "run-cas",
					organizationId: "org",
					fromStatus: "requires_approval",
					expectedUpdatedAt: at,
					patch: { status: "failed" },
				}),
			).toBe(false);

			await db.insert(runs).values({
				id: "run-claim",
				organizationId: "org",
				conversationId: "conv-1",
				status: "requires_approval",
				createdAt: at,
				updatedAt: at,
			});
			const events = coreTable(db, kernelRuntimeEvents);
			await db.insert(events).values({
				id: "claim-receipt",
				organizationId: "org",
				conversationId: "conv-1",
				runId: "run-claim",
				kind: "approval.resolved",
				createdAt: at,
				payload: { status: "approved" },
			});
			expect(
				await compareAndTouchKernelRuntimeRun(db, {
					id: "run-claim",
					organizationId: "org",
					status: "requires_approval",
					expectedUpdatedAt: at,
					updatedAt: later,
					requireNoDelegationResumeClaim: true,
					delegationResolutionClaimId: "claim-1",
					delegationApprovalEventId: "claim-receipt",
				}),
			).toBe(true);
			const claimed = await getKernelRuntimeRun(db, {
				id: "run-claim",
				organizationId: "org",
			});
			expect(claimed?.metadata).toMatchObject({
				homeDelegationResolutionClaim: {
					phase: "resolving",
					claimId: "claim-1",
				},
			});
			expect(
				await compareAndTouchKernelRuntimeRun(db, {
					id: "run-claim",
					organizationId: "org",
					status: "requires_approval",
					expectedUpdatedAt: later,
					updatedAt: "2026-11-20T12:10:00.000Z",
					requireNoDelegationResumeClaim: true,
					delegationResolutionClaimId: "claim-2",
					delegationApprovalEventId: "claim-receipt",
				}),
			).toBe(false);
		});

		it("lists pending delegations, quiet delegated runs and output lookups", async () => {
			const dispatch = coreTable(db, chatDispatchIdempotency);
			await db.insert(dispatch).values({
				idempotencyKey: "run-pending:turn-1",
				tediId: "tedi-1",
				conversationId: "conv-1",
				runId: null,
			});
			expect(
				await hasUnacceptedChatDispatch(db, {
					tediId: "tedi-1",
					homeRunId: "run-pending",
				}),
			).toBe(true);
			expect(
				await hasUnacceptedChatDispatch(db, {
					tediId: "tedi-1",
					homeRunId: "run-child",
				}),
			).toBe(false);

			expect(
				(
					await listPendingDelegationRuns(db, {
						organizationId: "org",
						limit: 10,
						kind: "home_delegation",
					})
				).map((row) => row.id),
			).toContain("run-pending");
			expect(
				await readLatestRunAwaitingDelegationApproval(db, {
					organizationId: "org",
					conversationId: "conv-1",
					excludeRunId: "run-child",
				}),
			).toMatchObject({ id: "run-pending" });

			expect(
				(
					await listQuietDelegatedRuns(db, {
						before: "2026-11-21T00:00:00.000Z",
						limit: 10,
					})
				).map((row) => row.id),
			).toContain("run-child");
			expect(
				await countActiveDelegatedRunsByTedi(db, {
					organizationId: "org",
					updatedSince: "2026-11-18T00:00:00.000Z",
				}),
			).toEqual(new Map([["tedi-1", 1]]));

			const runs = coreTable(db, kernelRuntimeRuns);
			await db.insert(runs).values([
				{
					id: "run-hint",
					organizationId: "org",
					conversationId: "conv-2",
					status: "completed",
					createdAt: "2026-11-20T13:00:00.000Z",
					updatedAt: "2026-11-20T13:00:00.000Z",
					metadata: {
						kernelRoute: {
							routeKind: "run_workflow",
							workflowHint: "nightly-sync",
						},
					},
				},
				{
					id: "run-output",
					organizationId: "org",
					conversationId: "conv-3",
					status: "completed",
					outputRevisionId: "rev-1",
					createdAt: "2026-11-20T14:00:00.000Z",
					updatedAt: "2026-11-20T14:00:00.000Z",
					metadata: { kernelOutputReceipt: { outputId: "out-1" } },
				},
			]);
			expect(
				await readPendingWorkflowHint(db, {
					organizationId: "org",
					conversationId: "conv-2",
					excludeRunId: "run-child",
				}),
			).toBe("nightly-sync");
			expect(
				await findKernelRuntimeRunForOutputRevision(db, {
					organizationId: "org",
					outputId: "out-1",
					revisionId: "rev-1",
				}),
			).toEqual({ id: "run-output", conversationId: "conv-3" });
			expect(
				await findKernelRuntimeRunForOutputRevision(db, {
					organizationId: "org",
					outputId: "other",
					revisionId: "rev-1",
				}),
			).toBeNull();
		});

		it("claims, dispatches and settles an approved Home delegation resume", async () => {
			const runs = coreTable(db, kernelRuntimeRuns);
			const events = coreTable(db, kernelRuntimeEvents);
			const items = coreTable(db, workItems);
			const submissions = coreTable(db, runtimeSubmissions);
			const expectedMetadata = {
				homeDelegation: {
					decision: { mode: "needs_approval", approvalRoute: "human" },
					workOrder: {
						targetTediId: "tedi-2",
						objective: "Original bounded task",
					},
				},
				keep: "untouched",
			};
			await db.insert(items).values({
				id: "work-resume",
				orgId: "org",
				title: "Existing Work",
				disposition: "accepted",
				version: 7,
				admissionSpecRevision: "spec-resume",
				createdAt: at,
				updatedAt: at,
			});
			await db.insert(runs).values({
				id: "run-resume",
				organizationId: "org",
				conversationId: "conv-resume",
				status: "requires_approval",
				createdAt: at,
				updatedAt: at,
				latestEventAt: at,
				metadata: expectedMetadata,
				runtimeMetadata: { workItemId: "work-resume" },
			});
			await db.insert(events).values({
				id: "resume-receipt",
				organizationId: "org",
				conversationId: "conv-resume",
				runId: "run-resume",
				kind: "approval.resolved",
				createdAt: at,
				payload: {
					status: "approved",
					resolvedBy: { type: "user", id: "reviewer-1" },
					delegationWorkOrder: {
						targetTediId: "tedi-2",
						objective: "Original bounded task",
					},
				},
			});
			const params: ClaimApprovedHomeDelegationResumeParams = {
				organizationId: "org",
				runId: "run-resume",
				conversationId: "conv-resume",
				expectedUpdatedAt: at,
				expectedLatestEventAt: at,
				expectedMetadata,
				approvalEventId: "resume-receipt",
				approvalResolvedAt: at,
				workItemId: "work-resume",
				workItemVersion: 7,
				admissionSpecRevision: "spec-resume",
				scopeDigest: "a".repeat(64),
				targetTediId: "tedi-2",
				expectedChildRunId: "child-resume",
				now: later,
				claimId: "claim-resume",
			};
			const claimed = await claimApprovedHomeDelegationResume(db, params);
			expect(claimed?.status).toBe("requires_approval");
			expect(claimed?.metadata).toMatchObject({
				homeDelegationResume: {
					version: 1,
					phase: "claimed",
					claimId: "claim-resume",
					targetTediId: "tedi-2",
					expectedChildRunId: "child-resume",
				},
				homeDelegation: {
					resolutionStatus: "approved",
					resolvedBy: { type: "user", id: "reviewer-1" },
				},
				delegationWorkOrder: {
					targetTediId: "tedi-2",
					objective: "Original bounded task",
				},
			});
			expect(
				await claimApprovedHomeDelegationResume(db, {
					...params,
					claimId: "claim-again",
				}),
			).toBeNull();

			const scope = {
				organizationId: params.organizationId,
				runId: params.runId,
				conversationId: params.conversationId,
				claimId: params.claimId,
				approvalEventId: params.approvalEventId,
				approvalResolvedAt: params.approvalResolvedAt,
				workItemId: params.workItemId,
				workItemVersion: params.workItemVersion,
				admissionSpecRevision: params.admissionSpecRevision,
				scopeDigest: params.scopeDigest,
				targetTediId: params.targetTediId,
				expectedChildRunId: params.expectedChildRunId,
			};
			expect(
				await beginApprovedHomeDelegationResumeDispatch(db, {
					...scope,
					now: "2026-11-20T12:06:00.000Z",
				}),
			).toBe(true);
			const dispatch = await recordApprovedHomeDelegationResumeDispatch(db, {
				...scope,
				outcome: "acknowledged",
				observedChildRunId: "child-resume",
				childConversationId: "child-conv-resume",
				now: "2026-11-20T12:07:00.000Z",
			});
			expect(dispatch.livePersisted).toBe(true);
			expect(dispatch.observationPersisted).toBe(true);
			expect(dispatch.run).toMatchObject({
				id: "run-resume",
				status: "queued",
				childRunId: "child-resume",
				delegatedTediId: "tedi-2",
				childConversationId: "child-conv-resume",
			});

			await db.insert(submissions).values({
				id: "submission-resume",
				organizationId: "org",
				subjectKind: "kernel",
				subjectId: "kernel:org",
				runId: "run-resume",
				conversationId: "conv-resume",
				sourceKind: "home",
				status: "running",
				abortRequestedAt: "2026-11-20T12:08:00.000Z",
			});
			expect(
				await recordApprovedHomeDelegationResumeStopOutcome(db, {
					...scope,
					stopAttemptId: "stop-1",
					outcome: "attempted",
					now: "2026-11-20T12:08:30.000Z",
				}),
			).toBe(true);
			expect(
				await recordApprovedHomeDelegationResumeStopOutcome(db, {
					...scope,
					stopAttemptId: "stop-1",
					outcome: "succeeded",
					now: "2026-11-20T12:09:00.000Z",
				}),
			).toBe(true);
			const settled = await getKernelRuntimeRun(db, {
				id: "run-resume",
				organizationId: "org",
			});
			expect(settled?.metadata).toMatchObject({
				homeDelegationResume: {
					phase: "observed",
					stopObservation: {
						attemptId: "stop-1",
						completion: { outcome: "succeeded" },
					},
				},
			});
		});
	});
}
