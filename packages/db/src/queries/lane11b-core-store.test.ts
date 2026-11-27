import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { tediApprovalRequests } from "../schema/approvals";
import { skillEntries } from "../schema/cognitive";
import { auditEvents } from "../schema/audit-events";
import { policyPacks } from "../schema/control-plane";
import {
	kernelRuntimeEvents,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";
import { tediCronExecutions } from "../schema/cron-executions";
import { memoryFacts } from "../schema/memory-graph";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getAlertState,
	listOpenAlertStates,
	markAlertsResolved,
	recordAlertState,
} from "./ops-alert-state";
import {
	countPendingApprovalsByTedi,
	countReviewFlaggedSkillsByTedi,
	summarizeCronExecutionsByTedi,
} from "./governance-overview";
import {
	hasActiveMemoryFactSource,
	listHomePlanDecisionEvents,
} from "./home-reflection";
import {
	getActivePolicyPackDefinition,
	getOrganizationTedi,
} from "./kernel-runtime-support";
import {
	listWithdrawnSteeringMessageIds,
	steeringWithdrawalEventId,
} from "./kernel-runtime-steering";
import {
	listHomeRunAuditReferences,
	listHomeRunWakeReceipts,
} from "./kernel-home-run-trace";
import { listMcpSubscriptionTargetsForCatalogApp } from "./mcp-subscription-targets";
import { resolveAgentLifecycleAuthorization } from "./mcp-agent-lifecycle";
import {
	claimDueMcpEventSubscriptions,
	deleteMcpEventSubscription,
	getMcpEventSubscription,
	recordMcpEventDelivery,
	upsertMcpEventSubscription,
} from "./mcp-event-subscriptions";

const stores = ["d1", "postgres"] as const;
for (const store of stores) {
	describe(`Lane 11b core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
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
			await db
				.insert(coreTable(db, organizations))
				.values([{ id: "org", name: "Example", slug: "example" }]);
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi-1",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("upserts, lists and resolves ops alert state", async () => {
			const at = "2026-11-25T00:00:00.000Z";
			await recordAlertState(db, {
				conditionKey: "cost-ledger-dark",
				severity: "P1",
				metricBucket: "1",
				detail: "ledger dark",
				status: "open",
				firstSeenAt: at,
				lastSeenAt: at,
				notifyCount: 1,
			});
			await recordAlertState(db, {
				conditionKey: "cron-dark:tedi-1:nightly",
				severity: "P2",
				firstSeenAt: at,
				lastSeenAt: at,
			});
			expect(await getAlertState(db, "cost-ledger-dark")).toMatchObject({
				severity: "P1",
				notifyCount: 1,
			});
			expect(
				(await listOpenAlertStates(db)).map((r) => r.conditionKey).sort(),
			).toEqual(["cost-ledger-dark", "cron-dark:tedi-1:nightly"]);
			await recordAlertState(db, {
				conditionKey: "cost-ledger-dark",
				severity: "P1",
				metricBucket: "2",
				detail: "still dark",
				status: "open",
				firstSeenAt: at,
				lastSeenAt: "2026-11-26T00:00:00.000Z",
				notifyCount: 2,
			});
			expect(await getAlertState(db, "cost-ledger-dark")).toMatchObject({
				metricBucket: "2",
				notifyCount: 2,
			});
			await markAlertsResolved(db, ["cron-dark:tedi-1:nightly"], at);
			expect(
				(await listOpenAlertStates(db)).map((r) => r.conditionKey),
			).toEqual(["cost-ledger-dark"]);
		});

		it("groups governance counts per tedi", async () => {
			const at = "2026-11-25T00:00:00.000Z";
			const approvals = coreTable(db, tediApprovalRequests);
			await db.insert(approvals).values([
				{
					id: "ap-1",
					tediId: "tedi-1",
					orgId: "org",
					actionType: "cron_job",
					description: "pending one",
					payload: {},
					status: "pending",
					createdAt: at,
					expiresAt: "2026-12-01T00:00:00.000Z",
				},
				{
					id: "ap-2",
					tediId: "tedi-1",
					orgId: "org",
					actionType: "cron_job",
					description: "approved one",
					payload: {},
					status: "approved",
					createdAt: at,
					expiresAt: "2026-12-01T00:00:00.000Z",
				},
			]);
			expect(await countPendingApprovalsByTedi(db, "org")).toEqual([
				{ tediId: "tedi-1", count: 1 },
			]);

			const skills = coreTable(db, skillEntries);
			await db.insert(skills).values([
				{
					id: "skill-1",
					organizationId: "org",
					tediId: "tedi-1",
					title: "Flagged",
					content: "procedure",
					reviewFlaggedAt: at,
				},
				{
					id: "skill-2",
					organizationId: "org",
					title: "Clean",
					content: "procedure",
				},
			]);
			expect(await countReviewFlaggedSkillsByTedi(db, "org")).toEqual([
				{ tediId: "tedi-1", count: 1 },
			]);

			const cron = coreTable(db, tediCronExecutions);
			await db.insert(cron).values([
				{
					id: "cron-1",
					tediId: "tedi-1",
					orgId: "org",
					cronName: "nightly",
					fireKey: "cron:sched:1",
					status: "success",
					startedAt: "2026-11-24T12:00:00.000Z",
				},
				{
					id: "cron-2",
					tediId: "tedi-1",
					orgId: "org",
					cronName: "nightly",
					fireKey: "cron:sched:2",
					status: "failure",
					startedAt: "2026-11-25T12:00:00.000Z",
				},
			]);
			expect(
				await summarizeCronExecutionsByTedi(
					db,
					"org",
					"2026-11-25T00:00:00.000Z",
				),
			).toEqual([
				{
					tediId: "tedi-1",
					fires: 1,
					failures: 1,
					lastFireAt: "2026-11-25T12:00:00.000Z",
				},
			]);
		});

		it("reads home reflection memory facts and plan decisions", async () => {
			const facts = coreTable(db, memoryFacts);
			await db.insert(facts).values({
				id: "fact-1",
				organizationId: "org",
				content: "deploys go through LEAD",
				factType: "decision",
				source: "conversation://s1",
			});
			expect(
				await hasActiveMemoryFactSource(db, {
					organizationId: "org",
					source: "conversation://s1",
				}),
			).toBe(true);
			expect(
				await hasActiveMemoryFactSource(db, {
					organizationId: "org",
					source: "conversation://missing",
				}),
			).toBe(false);

			const events = coreTable(db, kernelRuntimeEvents);
			await db.insert(events).values([
				{
					id: "ev-1",
					organizationId: "org",
					kind: "decision.recorded",
					conversationId: "conv-1",
					payload: { action: "home.plan.approved" },
					createdAt: "2026-11-25T10:00:00.000Z",
				},
				{
					id: "ev-2",
					organizationId: "org",
					kind: "decision.recorded",
					conversationId: "conv-1",
					payload: { action: "other.action" },
					createdAt: "2026-11-25T11:00:00.000Z",
				},
			]);
			const decisions = await listHomePlanDecisionEvents(db, {
				organizationId: "org",
				since: "2026-11-25T00:00:00.000Z",
				limit: 10,
			});
			expect(decisions.map((row) => row.id)).toEqual(["ev-1"]);
		});

		it("reads policy packs and organization tedis", async () => {
			const packs = coreTable(db, policyPacks);
			await db.insert(packs).values([
				{
					id: "pack-org",
					organizationId: "org",
					name: "Org Policy",
					slug: "org-policy",
					scope: "organization",
					status: "active",
					version: 1,
					target: "tedi",
					definition: { source: "organization" },
				},
				{
					id: "pack-system",
					name: "System Default",
					slug: "system-default",
					scope: "system",
					status: "active",
					version: 3,
					target: "tedi",
					publishedAt: "2026-01-01T00:00:00.000Z",
					definition: { source: "system" },
				},
			]);
			expect(await getActivePolicyPackDefinition(db, "org")).toEqual({
				source: "organization",
			});
			expect(await getActivePolicyPackDefinition(db, "org-empty")).toEqual({
				source: "system",
			});
			expect(
				await getOrganizationTedi(db, {
					id: "tedi-1",
					organizationId: "org",
				}),
			).toMatchObject({ id: "tedi-1", organizationId: "org" });
		});

		it("lists withdrawn steering message ids", async () => {
			const events = coreTable(db, kernelRuntimeEvents);
			await db.insert(events).values([
				{
					id: steeringWithdrawalEventId("org", "m-1"),
					organizationId: "org",
					kind: "message.progress",
					conversationId: "conv-1",
					messageId: "m-1",
					createdAt: "2026-11-25T10:00:00.000Z",
				},
				{
					id: steeringWithdrawalEventId("org", "m-2"),
					organizationId: "org",
					kind: "message.progress",
					conversationId: "conv-1",
					messageId: "m-2",
					createdAt: "2026-11-25T10:01:00.000Z",
				},
				{
					id: "ev-unrelated",
					organizationId: "org",
					kind: "message.progress",
					conversationId: "conv-1",
					messageId: "m-3",
					createdAt: "2026-11-25T10:02:00.000Z",
				},
			]);
			const withdrawn = await listWithdrawnSteeringMessageIds(db, {
				organizationId: "org",
				conversationId: "conv-1",
				messageIds: ["m-1", "m-2", "m-3"],
			});
			expect(withdrawn.sort()).toEqual(["m-1", "m-2"]);
		});

		it("lists home run wake receipts and audit references", async () => {
			const wakes = coreTable(db, kernelWakeQueue);
			await db.insert(wakes).values({
				id: "wake-1",
				organizationId: "org",
				parentConversationId: "conv-1",
				childRunId: "child-1",
				childStatus: "completed",
				queuedAt: "2026-11-25T10:00:00.000Z",
			});
			const receipts = await listHomeRunWakeReceipts(db, {
				organizationId: "org",
				childRunIds: ["child-1", "child-2"],
				limit: 10,
			});
			expect(receipts.map((row) => row.id)).toEqual(["wake-1"]);

			const audit = coreTable(db, auditEvents);
			await db.insert(audit).values([
				{
					id: "aud-1",
					organizationId: "org",
					actorId: "user-1",
					actorType: "user",
					action: "work.updated",
					resourceType: "work_item",
					metadata: { traceId: "child-1" },
					timestamp: new Date("2026-11-25T10:00:00.000Z"),
				},
				{
					id: "aud-2",
					organizationId: "org",
					actorId: "user-1",
					actorType: "user",
					action: "work.updated",
					resourceType: "work_item",
					metadata: { traceId: "child-9" },
					timestamp: new Date("2026-11-25T10:01:00.000Z"),
				},
			]);
			const references = await listHomeRunAuditReferences(db, {
				organizationId: "org",
				childRunIds: ["child-1"],
				from: new Date("2026-11-24T00:00:00.000Z"),
				to: new Date("2026-11-26T00:00:00.000Z"),
				limit: 10,
			});
			expect(references).toEqual([{ id: "aud-1", traceId: "child-1" }]);
		});

		it("lists mcp subscription targets and resolves lifecycle authorization", async () => {
			expect(
				await listMcpSubscriptionTargetsForCatalogApp(db, "catalog-none"),
			).toEqual([]);
			// Runs the full attempt/session/principal join; no fixtures means deny.
			await expect(
				resolveAgentLifecycleAuthorization(db, {
					organizationId: "org",
					principalId: "principal-1",
					sessionId: "session-1",
					endpoint: "workItems/addComment",
					args: { id: "wi-1" },
				}),
			).resolves.toBe(false);
			await expect(
				resolveAgentLifecycleAuthorization(db, {
					organizationId: "org",
					principalId: "principal-1",
					sessionId: "session-1",
					endpoint: "workItems/removeMember",
					args: {},
				}),
			).resolves.toBe(false);
		});

		it("upserts, claims, records and deletes mcp event subscriptions", async () => {
			const now = "2026-11-27T00:00:00.000Z";
			const params = {
				id: "sub-1",
				organizationId: "org",
				ownerSubject: "owner-1",
				mcpUrl: "https://mcp.example.com",
				eventName: "work.updated",
				arguments: { filter: "open" },
				callbackUrl: "https://callback.example.com/hook",
				sealedCredential: "sealed",
				cursor: "cursor-1",
				expiresAt: "2027-01-01T00:00:00.000Z",
				now,
			};
			const created = await upsertMcpEventSubscription(db, params);
			expect(created).toMatchObject({
				id: "sub-1",
				status: "active",
				cursor: "cursor-1",
			});
			expect(await getMcpEventSubscription(db, params)).toMatchObject({
				id: "sub-1",
			});
			// Renewal of the same id stays within the per-owner cap.
			for (let index = 2; index <= 20; index++) {
				const row = await upsertMcpEventSubscription(db, {
					...params,
					id: `sub-${index}`,
				});
				expect(row).not.toBeNull();
			}
			expect(
				await upsertMcpEventSubscription(db, {
					...params,
					id: "sub-over-cap",
				}),
			).toBeNull();
			expect(
				await upsertMcpEventSubscription(db, {
					...params,
					id: "sub-other-owner",
					ownerSubject: "owner-2",
				}),
			).not.toBeNull();

			const claimed = await claimDueMcpEventSubscriptions(db, {
				now: "2026-11-27T00:00:01.000Z",
				leaseUntil: "2026-11-27T00:05:00.000Z",
				limit: 50,
			});
			const mine = claimed.find((row) => row.id === "sub-1");
			expect(mine?.claimToken).toBeTruthy();
			expect(
				await recordMcpEventDelivery(db, {
					id: "sub-1",
					claimToken: mine!.claimToken!,
					organizationId: "org",
					cursor: "cursor-2",
					status: "active",
					consecutiveFailures: 0,
					nextAttemptAt: "2026-11-27T00:06:00.000Z",
					rateWindowStartedAt: null,
					rateWindowCount: 0,
					lastDeliveredAt: "2026-11-27T00:00:02.000Z",
					lastStatus: 200,
					now: "2026-11-27T00:00:02.000Z",
				}),
			).toBe(true);
			expect(await getMcpEventSubscription(db, params)).toMatchObject({
				id: "sub-1",
				cursor: "cursor-2",
				claimToken: null,
			});
			expect(await deleteMcpEventSubscription(db, params)).toBe(true);
			expect(await getMcpEventSubscription(db, params)).toBeNull();
		});
	});
}
