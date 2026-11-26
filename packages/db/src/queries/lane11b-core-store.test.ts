import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { tediApprovalRequests } from "../schema/approvals";
import { skillEntries } from "../schema/cognitive";
import { kernelRuntimeEvents } from "../schema/cognitive-runtime";
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
	});
}
