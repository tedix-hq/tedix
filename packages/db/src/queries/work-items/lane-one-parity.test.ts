import { DatabaseSync } from "node:sqlite";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createPGliteFacade } from "../../test/pglite-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { organizations } from "../../schema/organizations";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import { projects } from "../../schema/projects";
import { tediObjectives } from "../../schema/tedi-objectives";
import {
	workItems,
	workAttempts,
	workItemRelations,
} from "../../schema/work-items";
import { skillRuns } from "../../schema/cognitive";
import {
	kernelConversations,
	kernelConversationGrants,
	kernelRuntimeRuns,
} from "../../schema/cognitive-runtime";
import {
	workInteractions,
	workInteractionResponses,
	workInteractionDeliveries,
} from "../../schema/work-factory";
import { osGadgetExecutions, osWorkspaces } from "../../schema/os-workspaces";
import {
	listCardObjectives,
	listCardSourceWorkFacts,
	listCardStatuses,
	listDeckSourceStates,
	listDeckSweepOrganizations,
	listDeckSweepRecipients,
	listRecipientCards,
	findNotUsefulAnswer,
	getDeckSweepReceipt,
	recordDeckSweepReceipt,
	setDeckPipelineLearned,
} from "./deck-sweep";
import {
	listUndeliveredWorkInteractionResponses,
	recordWorkInteractionDeliveries,
	listWorkInteractionDeliveries,
} from "./interaction-deliveries";
import {
	attentionProjectBriefs,
	attentionProjectExists,
	listUnattendedObjectives,
	readAttentionSources,
	readAttentionFactoryLinks,
} from "../work-attention";

const at = "2026-11-25T12:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = new DatabaseSync(":memory:");
				const tables = new Set<SQLiteTable>();
				const include = (table: SQLiteTable) => {
					if (tables.has(table)) return;
					tables.add(table);
					for (const key of getTableConfig(table).foreignKeys)
						include(key.reference().foreignTable);
				};
				[
					organizations,
					organizationMembers,
					tedis,
					projects,
					tediObjectives,
					workItems,
					workAttempts,
					workItemRelations,
					skillRuns,
					kernelConversations,
					kernelConversationGrants,
					kernelRuntimeRuns,
					workInteractions,
					workInteractionResponses,
					workInteractionDeliveries,
					osWorkspaces,
					osGadgetExecutions,
				].forEach(include);
				sqlite.exec(schemaDdl(...tables));
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			}
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "orchard",
					name: "Orchard",
					slug: "orchard",
					metadata: {
						secretEgressMode: "warn",
						decisionLearning: DecisionLearningConfigSchema.parse({}),
					},
				},
				{ id: "river", name: "River", slug: "river", metadata: {} },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "gardener",
				organizationId: "orchard",
				name: "Gardener",
				slug: "gardener",
			});
			await db.insert(coreTable(db, tediObjectives)).values({
				id: "grow",
				orgId: "orchard",
				tediId: "gardener",
				title: "Grow",
				priority: 1,
				createdAt: at,
			});
			await db.insert(coreTable(db, projects)).values({
				id: "trees",
				orgId: "orchard",
				key: "TREES",
				name: "Trees",
				objectiveId: "grow",
				metadata: { factory: { goal: "Harvest" } },
				createdAt: at,
			});
			await db.insert(coreTable(db, workItems)).values([
				{
					id: "source",
					orgId: "orchard",
					projectId: "trees",
					title: "Harvest",
					disposition: "accepted",
					riskLevel: "medium",
					createdAt: at,
				},
				{
					id: "waiting",
					orgId: "orchard",
					projectId: "trees",
					title: "Pack",
					disposition: "accepted",
					createdAt: at,
				},
				{
					id: "foreign",
					orgId: "river",
					title: "Foreign",
					disposition: "completed",
					createdAt: at,
				},
			]);
			await db.insert(coreTable(db, workItemRelations)).values({
				id: "blocks",
				orgId: "orchard",
				fromWorkItemId: "source",
				toWorkItemId: "waiting",
				relationType: "blocks",
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				orgId: "orchard",
				workItemId: "waiting",
				executorType: "tedi",
				executorId: "gardener",
				runtimeState: "running",
				attemptNumber: 1,
				startedAt: at,
				heartbeatAt: at,
				expiresAt: "2099-01-01T00:00:00.000Z",
				metadata: { lane: true },
			});
			await db.insert(coreTable(db, workInteractions)).values([
				{
					id: "card",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "resolved",
					subject: "Harvest?",
					prompt: "Ready?",
					creatorType: "user",
					creatorId: "reader",
					targetType: "user",
					targetId: "reader",
					createdAt: at,
					metadata: { sessionId: "session", host: "codex" },
				},
				{
					id: "private",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "resolved",
					subject: "Private",
					prompt: "Private",
					creatorType: "user",
					creatorId: "someone",
					targetType: "user",
					targetId: "someone",
					createdAt: at,
					metadata: { sessionId: "private" },
				},
				{
					id: "refused",
					orgId: "orchard",
					workItemId: "source",
					kind: "question",
					status: "cancelled",
					subject: "  Harvest? ",
					prompt: "Ready?",
					creatorType: "user",
					creatorId: "reader",
					targetType: "user",
					targetId: "reader",
					createdAt: at,
					metadata: { curation: { notUseful: { reason: "Later" } } },
				},
			]);
			await db.insert(coreTable(db, workInteractionResponses)).values([
				{
					id: "answer",
					orgId: "orchard",
					interactionId: "card",
					resolvedRequestVersion: 1,
					resolutionFence: "answer",
					responderType: "user",
					responderId: "reader",
					responseKind: "answer",
					body: "Yes",
					resolvesRequest: true,
					respondedAt: at,
					metadata: { source: "tedix-os" },
				},
				{
					id: "private-answer",
					orgId: "orchard",
					interactionId: "private",
					resolvedRequestVersion: 1,
					resolutionFence: "private-answer",
					responderType: "user",
					responderId: "someone",
					responseKind: "answer",
					body: "Private",
					resolvesRequest: true,
					respondedAt: at,
				},
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		it("reads deck sets beyond D1's parameter limit with tenant-scoped state, objectives and dependency facts", async () => {
			const ids = [
				...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
				"source",
				"waiting",
				"foreign",
			];
			expect(
				await listDeckSourceStates(db, "orchard", ids, new Date(at)),
			).toEqual(
				new Map([
					["source", "accepted"],
					["waiting", "blocked"],
				]),
			);
			expect(await listCardStatuses(db, "orchard", [...ids, "card"])).toEqual(
				new Map([["card", "resolved"]]),
			);
			expect(
				(
					await listCardObjectives(db, "orchard", [
						{ id: "card", workItemId: "source" },
					])
				).get("card"),
			).toMatchObject({ id: "grow", top: true });
			expect(
				(
					await listCardSourceWorkFacts(db, "orchard", [
						{ id: "card", workItemId: "source" },
					])
				).get("card"),
			).toMatchObject({ blocksCount: 1, blocksRunning: true });
			expect(await listDeckSweepOrganizations(db)).toEqual(["orchard"]);
			expect(await listDeckSweepRecipients(db, "orchard", 10)).toEqual([]);
			expect(
				(
					await listRecipientCards(db, {
						orgId: "orchard",
						recipientId: "reader",
						status: "resolved",
						limit: 20,
					})
				)[0]?.id,
			).toBe("card");
			expect(
				await findNotUsefulAnswer(db, {
					orgId: "orchard",
					recipientId: "reader",
					subject: "Harvest?",
					workItemId: "source",
				}),
			).toMatchObject({ id: "refused", reason: "Later" });
		});
		it("preserves organization metadata while writing nested learned config and a sweep receipt", async () => {
			await setDeckPipelineLearned(db, "orchard", {
				rules: [],
				hidingClasses: [],
			});
			const receipt = {
				at,
				mode: "shadow" as const,
				recipients: 1,
				retired: 0,
				merged: 0,
				proposed: 0,
				ranked: 0,
				rankNotes: {},
				hidden: 0,
				wouldRetire: 0,
				errors: 0,
				removed: [],
				metrics: [],
			};
			await recordDeckSweepReceipt(db, "orchard", receipt);
			expect(await getDeckSweepReceipt(db, "orchard")).toEqual(receipt);
			const table = coreTable(db, organizations);
			const [row] = await db
				.select({ metadata: table.metadata })
				.from(table)
				.where(eq(table.id, "orchard"));
			expect(row?.metadata).toMatchObject({
				secretEgressMode: "warn",
				decisionLearning: { deckPipeline: { rules: [], hidingClasses: [] } },
			});
			expect(await getDeckSweepReceipt(db, "river")).toBeNull();
		});
		it("writes only owned delivery rows and preserves the first channel and timestamp on acknowledgement", async () => {
			const actor = { type: "user" as const, id: "reader" };
			const p = {
				orgId: "orchard",
				actor,
				responseIds: ["answer", "private-answer"],
				via: "hook" as const,
				acknowledged: false,
				now: at,
			};
			expect(
				(
					await listUndeliveredWorkInteractionResponses(db, {
						orgId: "orchard",
						actor,
						respondedAfter: at,
						sessionId: "session",
						host: "codex",
					})
				).map((row) => row.responseId),
			).toEqual(["answer"]);
			expect(await recordWorkInteractionDeliveries(db, p)).toMatchObject([
				{
					responseId: "answer",
					deliveredAt: at,
					deliveredVia: "hook",
					acknowledgedAt: null,
				},
			]);
			expect(
				await recordWorkInteractionDeliveries(db, {
					...p,
					via: "handoff",
					acknowledged: true,
					now: "2026-11-25T13:00:00.000Z",
				}),
			).toMatchObject([
				{
					deliveredAt: at,
					deliveredVia: "hook",
					acknowledgedAt: "2026-11-25T13:00:00.000Z",
				},
			]);
			expect(
				await listWorkInteractionDeliveries(db, {
					orgId: "orchard",
					interactionId: "private",
				}),
			).toEqual([]);
			expect(
				await listUndeliveredWorkInteractionResponses(db, {
					orgId: "orchard",
					actor,
					respondedAfter: at,
				}),
			).toEqual([]);
		});
		it("reads Attention aggregates, boolean JSON and project briefs with tenant boundaries", async () => {
			expect(await attentionProjectExists(db, "river", "trees")).toBe(false);
			expect((await attentionProjectBriefs(db, "orchard"))[0]).toMatchObject({
				id: "trees",
			});
			const result = await readAttentionSources(
				db,
				"orchard",
				"2026-01-01T00:00:00.000Z",
				"reader",
				"reader",
			);
			expect(result.attempts[0]).toMatchObject({
				id: "attempt",
				registeredLane: true,
			});
			expect(result.projects[0]).toMatchObject({
				id: "trees",
				active: 1,
				recent: 1,
			});
			expect(await listUnattendedObjectives(db, "orchard", at)).toMatchObject([
				{ id: "grow", lastAttentionAt: null },
			]);
			expect(
				await readAttentionFactoryLinks(db, "river", "reader", at),
			).toEqual([]);
		});
	});
