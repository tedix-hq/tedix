import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { agentSessionRequests } from "../schema/agent-session-requests";
import { auditEvents } from "../schema/audit-events";
import {
	kernelConversationGrants,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";
import { policyPacks } from "../schema/control-plane";
import { kernelRequests } from "../schema/kernel-requests";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { workAdmissions } from "../schema/work-factory";
import { workAttempts, workItems } from "../schema/work-items";
import { workstations, workstationLeases } from "../schema/workstations";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getHomeKernelRequest,
	getKernelRequest,
	listDispatcherAttemptCaptureOrganizations,
	listDueKernelRequestOrganizations,
	listDueKernelRequests,
	listDueKernelRequestsWithHomeRuns,
	listKernelRequestEvents,
	listLocalRequestsForKernelCapture,
	listUncapturedDispatcherAttempts,
	projectKernelRequestOnHomeRun,
	publishKernelRequestReport,
	publishLocalKernelRequestReport,
	receiveKernelRequest,
	transitionKernelRequest,
	transitionKernelRequests,
	wakeRepositoryKernelRequests,
} from "./kernel-requests";
import {
	getActiveOrganizationPolicyPack,
	getActivePolicyPackDefinition,
	getOrganizationTedi,
	insertWorkItemCommentIfAbsent,
} from "./kernel-runtime-support";
import {
	listHomeRunAuditReferences,
	listHomeRunWakeReceipts,
	listHomeRunWorkstationReferences,
} from "./kernel-home-run-trace";
import {
	listWithdrawnSteeringMessageIds,
	steeringWithdrawalEventId,
} from "./kernel-runtime-steering";

const now = "2026-11-26T10:00:00.000Z";
const later = "2026-11-27T10:00:00.000Z";
const snapshot = {
	state: "received" as const,
	workItemId: null,
	attemptId: null,
	briefRevision: 0,
	checks: [],
	acceptanceKey: null,
	observations: [],
	outcome: null,
	delivery: null,
	learning: null,
};
const intake = (id: string) => ({
	id,
	organizationId: "org",
	ownerUserId: "owner",
	sourceKind: "home" as const,
	sourceId: id,
	snapshot,
	nextOwner: "kernel",
	nextAction: "file",
	nextDueAt: now,
	lastEventId: `${id}:1`,
	createdAt: now,
	updatedAt: now,
});

for (const store of ["d1", "postgres"] as const) {
	describe(`remaining kernel queries ${store}`, () => {
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
				{ id: "org", name: "Example", slug: "example" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "owner",
				organizationId: "org",
				name: "Owner",
				slug: "owner",
			});
			await db.insert(coreTable(db, workItems)).values({
				id: "work",
				orgId: "org",
				title: "Example",
				admissionSpecRevision: "fixture",
				disposition: "accepted",
				createdAt: now,
			});
			await db.insert(coreTable(db, workAdmissions)).values({
				id: "admission",
				orgId: "org",
				workItemId: "work",
				workItemVersion: 1,
				admissionSpecRevision: "fixture",
				executorType: "tedi",
				executorId: "owner",
				decision: "admitted",
				decidedAt: now,
				expiresAt: later,
				createdAt: now,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				admissionId: "admission",
				finishedAt: now,
				orgId: "org",
				workItemId: "work",
				executorType: "tedi",
				executorId: "owner",
				attemptNumber: 1,
				runtimeState: "finished",
				outcome: "succeeded",
				startedAt: now,
				heartbeatAt: now,
				expiresAt: later,
				metadata: { dispatchVersion: 1 },
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("deduplicates intake and fences CAS/history, including rollback on event collision", async () => {
			const row = intake("cas");
			const first = await receiveKernelRequest(db, row);
			expect(
				await receiveKernelRequest(db, {
					...row,
					id: "replay",
					lastEventId: "replay:1",
				}),
			).toEqual(first);
			const transition = {
				...row,
				expectedVersion: 1,
				eventId: "cas:2",
				now,
				snapshot: { ...snapshot, state: "filed" as const, workItemId: "work" },
			};
			expect(await transitionKernelRequest(db, transition)).toMatchObject({
				version: 2,
			});
			await receiveKernelRequest(db, intake("second"));
			await transitionKernelRequests(db, [
				transition,
				{ ...transition, id: "second", eventId: "second:2" },
			]);
			expect((await listKernelRequestEvents(db, row)).map((r) => r.id)).toEqual(
				["cas:1", "cas:2"],
			);
			await expect(
				transitionKernelRequest(db, {
					...transition,
					expectedVersion: 2,
					eventId: "second:1",
				}),
			).rejects.toThrow();
			expect(await getKernelRequest(db, row)).toMatchObject({ version: 2 });
			for (const wrong of [
				{ ...row, organizationId: "other" },
				{ ...row, ownerUserId: "other" },
			]) {
				expect(await getKernelRequest(db, wrong)).toBeUndefined();
				expect(await listKernelRequestEvents(db, wrong)).toEqual([]);
				expect(
					await transitionKernelRequest(db, {
						...transition,
						...wrong,
						expectedVersion: 2,
					}),
				).toBeUndefined();
			}
		});

		it("keeps due ordering and scoped Home/Work joins while projecting only request metadata", async () => {
			await db.insert(coreTable(db, kernelRuntimeRuns)).values({
				id: "home-run",
				organizationId: "org",
				conversationId: "home",
				metadata: { keep: "original" },
				runtimeMetadata: { workItemId: "work" },
			});
			const home = await receiveKernelRequest(db, {
				...intake("home:home-run"),
				sourceId: "home-run",
			});
			expect(home).toBeDefined();
			await projectKernelRequestOnHomeRun(db, home!);
			const params = { organizationId: "org", now, limit: 50 };
			const joined = await listDueKernelRequestsWithHomeRuns(db, params);
			expect(joined.map((r) => r.request)).toEqual(
				await listDueKernelRequests(db, params),
			);
			expect(joined.find((r) => r.request.id === home!.id)).toMatchObject({
				homeRun: {
					metadata: {
						keep: "original",
						kernelRequestId: home!.id,
						kernelRequestAcceptance: snapshot,
					},
				},
				work: { id: "work" },
				attempt: { id: "attempt", outcome: "succeeded" },
			});
			expect(joined.find((r) => r.request.id === "cas")).toMatchObject({
				homeRun: null,
				work: null,
				attempt: null,
			});
			expect(await getHomeKernelRequest(db, "org", "home-run")).toMatchObject({
				id: home!.id,
			});
			expect(
				await getHomeKernelRequest(db, "other", "home-run"),
			).toBeUndefined();
			expect(await listDueKernelRequestOrganizations(db, now)).toEqual([
				{ organizationId: "org" },
			]);
		});

		it("wakes only matching active repository requests and explicitly selected Work attempts", async () => {
			const table = coreTable(db, kernelRequests);
			for (const [id, organizationId, nextDueAt, targetId] of [
				["wake-match", "org", later, "repo"],
				["wake-closed", "org", null, "repo"],
				["wake-foreign", "other", later, "repo"],
				["wake-miss", "org", later, "else"],
			] as const)
				await db.insert(table).values({
					...intake(id),
					organizationId,
					nextDueAt,
					snapshot: {
						...snapshot,
						checks: [
							{
								kind: "repository_delivery",
								targetId,
								surface: "api",
								commitSha: "a".repeat(40),
							},
						],
					},
				});
			await db.insert(table).values({
				...intake("wake-attempt"),
				sourceKind: "work_attempt",
				nextDueAt: later,
			});
			const wake = {
				organizationId: "org",
				targetIds: ["repo"],
				workAttempts: false,
				now,
			};
			expect((await wakeRepositoryKernelRequests(db, wake)).meta.changes).toBe(
				1,
			);
			expect(
				(await wakeRepositoryKernelRequests(db, { ...wake, targetIds: [] }))
					.meta.changes,
			).toBe(0);
			expect(
				(
					await wakeRepositoryKernelRequests(db, {
						...wake,
						targetIds: [],
						workAttempts: true,
					})
				).meta.changes,
			).toBe(1);
			expect(await getKernelRequest(db, intake("wake-match"))).toMatchObject({
				nextDueAt: now,
				snapshot: { checks: [{ targetId: "repo" }] },
			});
			expect(await getKernelRequest(db, intake("wake-miss"))).toMatchObject({
				nextDueAt: later,
			});
		});

		it("fences Home and local reports against stale versions, revoked access, cancellation and successors", async () => {
			const delivery = {
				intentId: "intent",
				status: "pending" as const,
				receiptRef: null,
			};
			const report = { ...snapshot, acceptanceKey: "key", delivery };
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "member",
				organizationId: "org",
				descopeUserId: "owner",
				email: "owner@example.com",
				status: "active",
			});
			await receiveKernelRequest(db, { ...intake("report"), snapshot: report });
			await db.insert(coreTable(db, agentSessionRequests)).values({
				id: "local",
				organizationId: "org",
				userId: "owner",
				harness: "codex",
				sessionKey: "session",
				kind: "request",
				text: "Example",
				status: "open",
				sourceAt: now,
				sourceKey: "prompt:1",
				statusChangedAt: now,
			});
			await receiveKernelRequest(db, {
				...intake("local-report"),
				sourceKind: "agent_session_request",
				sourceId: "local",
				snapshot: report,
			});
			const home = {
				...intake("report"),
				expectedVersion: 1,
				acceptanceKey: "key",
				attemptId: "attempt",
				workItemId: "work",
				intentId: "intent",
				conversationId: "home",
				runId: "home-run",
				messageId: "message",
				now,
				payload: { content: "Verified", metadata: { requestId: "report" } },
			};
			const local = {
				...home,
				id: "local-report",
				sourceId: "local",
				evidence: "Verified",
			};
			for (const expectedVersion of [0, 2]) {
				expect(
					await publishKernelRequestReport(db, { ...home, expectedVersion }),
				).toBeUndefined();
				expect(
					await publishLocalKernelRequestReport(db, {
						...local,
						expectedVersion,
					}),
				).toBeUndefined();
			}
			const members = coreTable(db, organizationMembers);
			await db
				.update(members)
				.set({ status: "deactivated" })
				.where(eq(members.id, "member"));
			expect(await publishKernelRequestReport(db, home)).toBeUndefined();
			expect(await publishLocalKernelRequestReport(db, local)).toBeUndefined();
			await db
				.update(members)
				.set({ status: "active" })
				.where(eq(members.id, "member"));
			const work = coreTable(db, workItems);
			await db
				.update(work)
				.set({ disposition: "cancelled" })
				.where(eq(work.id, "work"));
			expect(await publishKernelRequestReport(db, home)).toBeUndefined();
			expect(await publishLocalKernelRequestReport(db, local)).toBeUndefined();
			await db
				.update(work)
				.set({ disposition: "accepted" })
				.where(eq(work.id, "work"));
			const grants = coreTable(db, kernelConversationGrants);
			await db.insert(grants).values({
				id: "grant",
				organizationId: "org",
				conversationId: "home",
				granteeDescopeUserId: "other",
				access: "owner",
			});
			expect(await publishKernelRequestReport(db, home)).toBeUndefined();
			await db.delete(grants).where(eq(grants.id, "grant"));
			expect(await publishKernelRequestReport(db, home)).toMatchObject({
				id: "intent",
				payload: home.payload,
			});
			expect(await publishKernelRequestReport(db, home)).toMatchObject({
				id: "intent",
				payload: home.payload,
			});
			expect(await publishLocalKernelRequestReport(db, local)).toMatchObject({
				status: "done",
				evidence: "Verified",
			});
			const capture = {
				organizationId: "org",
				userId: "owner",
				harness: "codex" as const,
				sessionKey: "session",
				sourceAt: now,
			};
			expect(
				await listLocalRequestsForKernelCapture(db, capture),
			).toMatchObject([{ id: "local", laneRunning: false }]);
			expect(
				await listLocalRequestsForKernelCapture(db, {
					...capture,
					userId: "other",
				}),
			).toEqual([]);
			const [admission] = await db.select().from(coreTable(db, workAdmissions));
			await db
				.insert(coreTable(db, workAdmissions))
				.values({ ...admission!, id: "admission-2" });
			await db.insert(coreTable(db, workAttempts)).values({
				id: "successor",
				admissionId: "admission-2",
				orgId: "org",
				workItemId: "work",
				executorType: "tedi",
				executorId: "owner",
				attemptNumber: 2,
				startedAt: now,
				heartbeatAt: now,
				expiresAt: later,
			});
			await receiveKernelRequest(db, {
				...intake("successor-report"),
				snapshot: {
					...report,
					delivery: { ...delivery, intentId: "next-intent" },
				},
			});
			expect(
				await publishKernelRequestReport(db, {
					...home,
					id: "successor-report",
					intentId: "next-intent",
				}),
			).toBeUndefined();
			expect(await publishLocalKernelRequestReport(db, local)).toBeUndefined();
		});

		it("selects tenant policy revisions without granting system autonomy and captures opted-in dispatchers once", async () => {
			const packs = coreTable(db, policyPacks);
			await db.insert(packs).values({
				id: "system",
				name: "System",
				slug: "system-default",
				scope: "system",
				target: "tedi",
				status: "active",
				version: 100,
				publishedAt: now,
				definition: { gatingPolicy: { autonomy: { maxRisk: "medium" } } },
			});
			expect(
				await getActiveOrganizationPolicyPack(db, "other"),
			).toBeUndefined();
			expect(await getActivePolicyPackDefinition(db, "other")).toEqual({
				gatingPolicy: {},
			});
			await db.insert(packs).values({
				id: "tenant",
				organizationId: "org",
				name: "Tenant",
				slug: "tenant",
				target: "tedi",
				status: "active",
				version: 1,
				definition: {
					governancePolicy: { autonomy: { policyPack: { id: "forged" } } },
					kernelRequestCoordinator: {
						enabled: true,
						workAttemptDelivery: {},
					},
				},
			});
			expect(await getActivePolicyPackDefinition(db, "org")).toMatchObject({
				governancePolicy: {
					autonomy: { policyPack: { id: "tenant", version: 1 } },
				},
			});
			expect(await listDispatcherAttemptCaptureOrganizations(db, now)).toEqual([
				{ organizationId: "org" },
			]);
			expect(
				await listUncapturedDispatcherAttempts(db, {
					organizationId: "org",
					since: now,
					limit: 20,
					workItemIds: ["work"],
				}),
			).toMatchObject([{ id: "attempt", metadata: { dispatchVersion: 1 } }]);
			await receiveKernelRequest(db, {
				...intake("captured"),
				sourceKind: "work_attempt",
				sourceId: "attempt",
			});
			expect(await listDispatcherAttemptCaptureOrganizations(db, now)).toEqual(
				[],
			);
			expect(
				await listUncapturedDispatcherAttempts(db, {
					organizationId: "org",
					since: now,
					limit: 20,
				}),
			).toEqual([]);
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Example",
				slug: "example",
			});
			expect(
				await getOrganizationTedi(db, { id: "tedi", organizationId: "org" }),
			).toMatchObject({ id: "tedi" });
			expect(
				await getOrganizationTedi(db, { id: "tedi", organizationId: "other" }),
			).toBeUndefined();
			const comment = {
				id: "comment",
				orgId: "org",
				workItemId: "work",
				authorType: "system" as const,
				body: "Example",
				createdAt: now,
			};
			expect(await insertWorkItemCommentIfAbsent(db, comment)).toBe(true);
			expect(await insertWorkItemCommentIfAbsent(db, comment)).toBe(false);
		});

		it("scopes Home audit, wake and workstation references and maps JSON and timestamps", async () => {
			const events = coreTable(db, auditEvents);
			for (const [id, organizationId, traceId, timestamp] of [
				["audit", "org", "child", now],
				["audit-foreign", "other", "child", now],
				["audit-late", "org", "child", later],
				["audit-miss", "org", "else", now],
			] as const)
				await db.insert(events).values({
					id,
					organizationId,
					actorId: "owner",
					actorType: "user",
					action: "example",
					resourceType: "tool",
					metadata: { traceId },
					timestamp: new Date(timestamp),
				});
			expect(
				await listHomeRunAuditReferences(db, {
					organizationId: "org",
					childRunIds: ["child"],
					from: new Date(now),
					to: new Date(now),
					limit: 20,
				}),
			).toEqual([{ id: "audit", traceId: "child" }]);
			await db.insert(coreTable(db, kernelWakeQueue)).values([
				{
					id: "wake",
					organizationId: "org",
					parentConversationId: "home",
					childRunId: "child",
					childStatus: "completed",
					queuedAt: now,
				},
				{
					id: "wake-other",
					organizationId: "other",
					parentConversationId: "home",
					childRunId: "child",
					childStatus: "completed",
					queuedAt: now,
				},
			]);
			expect(
				await listHomeRunWakeReceipts(db, {
					organizationId: "org",
					childRunIds: ["child"],
					limit: 20,
				}),
			).toMatchObject([{ id: "wake" }]);
			await db.insert(coreTable(db, workstations)).values({
				id: "station",
				profileId: "general",
				status: "ready",
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(coreTable(db, workstationLeases)).values({
				id: "lease",
				workstationId: "station",
				profileId: "general",
				orgId: "org",
				kernelRunId: "home-run",
				status: "released",
				createdAt: now,
				updatedAt: now,
				metadata: { proof: true },
			});
			expect(
				await listHomeRunWorkstationReferences(db, {
					organizationId: "org",
					kernelRunId: "home-run",
					limit: 20,
				}),
			).toEqual([{ id: "lease", workItemId: null, metadata: { proof: true } }]);
			expect(
				await listHomeRunWorkstationReferences(db, {
					organizationId: "other",
					kernelRunId: "home-run",
					limit: 20,
				}),
			).toEqual([]);
		});

		it("finds steering withdrawals across bounded chunks without crossing conversation scope", async () => {
			const ids = Array.from({ length: 105 }, (_, i) => `message-${i}`);
			for (const messageId of ids)
				await db.insert(coreTable(db, kernelRuntimeEvents)).values({
					id: steeringWithdrawalEventId("org", messageId),
					organizationId: "org",
					conversationId: "home",
					kind: "message.progress",
					messageId,
					createdAt: now,
				});
			const input = {
				organizationId: "org",
				conversationId: "home",
				messageIds: [...ids, ids[0]!],
			};
			expect(new Set(await listWithdrawnSteeringMessageIds(db, input))).toEqual(
				new Set(ids),
			);
			expect(
				await listWithdrawnSteeringMessageIds(db, {
					...input,
					conversationId: "other",
				}),
			).toEqual([]);
			expect(
				await listWithdrawnSteeringMessageIds(db, {
					...input,
					organizationId: "other",
				}),
			).toEqual([]);
		});
	});
}
