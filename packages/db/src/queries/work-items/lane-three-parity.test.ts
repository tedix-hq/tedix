import {
	createChildWorkItem,
	inheritedChildAuthority,
	workDelegationAncestors,
} from "./child-delegation";
import { taskContractRefusal } from "./task-contract";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import { listWorkActivity } from "./activity";
import { workAgentSessions } from "../../schema/work-agent-sessions";
import {
	createWorkCase,
	addWorkCaseDependency,
	listWorkCases,
	linkWorkItemToCase,
	detachWorkItemFromCase,
	updateWorkCase,
} from "./cases";
import {
	listContinuityScopes,
	readStallRecoveryPage,
	getStallRecoveryCheckpoint,
	advanceStallRecoveryCheckpoint,
	listStallReceipts,
	type StallRecoveryCursor,
} from "./stall-recovery";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import { organizations } from "../../schema/organizations";
import { projects } from "../../schema/projects";
import { tedis } from "../../schema/tedis";
import {
	workItems,
	workAttempts,
	workItemOrgCounts,
	workItemComments,
	workEvents,
	workItemRelations,
} from "../../schema/work-items";
import {
	workAdmissions,
	workResourcePools,
	workResourceRequirements,
	workCases,
	workCaseItems,
	workCaseDependencies,
} from "../../schema/work-factory";
import {
	createWorkItem,
	acceptWorkItem,
	completeWorkItem,
	cancelWorkItem,
	updateWorkItemSpecification,
	getWorkItemById,
	getWorkItemsByIds,
	getWorkItemBySourceIntentId,
	listWorkItems,
	listWorkItemsPage,
	getGoalLoopWorkItemSnapshot,
	listOpenWorkItemsAcrossProjects,
	upsertWorkItemProjection,
	listOrgWorkItemProjections,
} from "./crud";
import { listOrgWorkAttempts, listOrgWorkRecovery } from "./projections";

const at = "2026-11-25T12:00:00.000Z";
const expires = "2099-01-01T00:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			let install: (() => Promise<void>) | undefined;
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => {
					if (sqlite.isOpen) sqlite.close();
				};
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				const migrations = readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				});
				const installation = migrations.findIndex((migration) =>
					migration.sql.some((ddl) =>
						ddl.includes("CREATE FUNCTION maintain_work_item_org_counts()"),
					),
				);
				if (installation < 0)
					throw new Error("Missing Work count/case migration");
				for (const migration of migrations.slice(0, installation))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				install = async () => {
					for (const migration of migrations.slice(installation))
						for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				};
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "orchard", name: "Orchard", slug: "orchard" },
				{ id: "river", name: "River", slug: "river" },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "gardener",
				organizationId: "orchard",
				name: "Gardener",
				slug: "gardener",
				status: "active",
			});
			await db.insert(coreTable(db, projects)).values({
				id: "trees",
				orgId: "orchard",
				key: "TREES",
				name: "Trees",
				createdAt: at,
			});
			await db.insert(coreTable(db, workItems)).values([
				{
					id: "task",
					orgId: "orchard",
					projectId: "trees",
					title: "Harvest 100%_",
					disposition: "accepted",
					sourceIntentId: "harvest",
					admissionSpecRevision: "spec-task",
					createdAt: at,
					metadata: { nested: { value: "retained" } },
				},
				{
					id: "held",
					orgId: "orchard",
					title: "Held",
					disposition: "accepted",
					dispatchState: "held",
					admissionSpecRevision: "spec-held",
					createdAt: at,
					metadata: {
						laneDispatch: { reason: "Review dependencies" },
						needsProject: true,
					},
				},
				{
					id: "foreign",
					orgId: "river",
					title: "Foreign",
					admissionSpecRevision: "spec-foreign",
					createdAt: at,
				},
			]);
			await install?.();
			await db.insert(coreTable(db, workAdmissions)).values({
				id: "admission",
				orgId: "orchard",
				workItemId: "task",
				workItemVersion: 1,
				admissionSpecRevision: "spec-task",
				executorType: "tedi",
				executorId: "gardener",
				decision: "admitted",
				decidedAt: at,
				expiresAt: expires,
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "attempt",
				orgId: "orchard",
				workItemId: "task",
				admissionId: "admission",
				executorType: "tedi",
				executorId: "gardener",
				attemptNumber: 1,
				runtimeState: "running",
				startedAt: at,
				heartbeatAt: at,
				expiresAt: expires,
				metadata: { nested: { value: "attempt" } },
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("reads exact totals, native JSON and large ID sets without losing tenant filters", async () => {
			expect((await listWorkItemsPage(db, { orgId: "orchard" })).total).toBe(2);
			expect((await getWorkItemById(db, "task", "orchard"))?.metadata).toEqual({
				nested: { value: "retained" },
			});
			expect(await getWorkItemById(db, "task", "river")).toBeNull();
			expect(
				(
					await getWorkItemBySourceIntentId(db, {
						orgId: "orchard",
						sourceIntentId: "harvest",
					})
				)?.id,
			).toBe("task");
			expect(
				(await listWorkItems(db, { orgId: "orchard", projectId: "trees" })).map(
					(row) => row.id,
				),
			).toEqual(["task"]);
			expect(
				(
					await getWorkItemsByIds(db, {
						orgId: "orchard",
						ids: [
							...Array.from({ length: 300 }, (_, i) => `absent-${i}`),
							"foreign",
							"task",
						],
					})
				).map((row) => row.id),
			).toEqual(["task"]);
			expect(
				(
					await listWorkItemsPage(db, {
						orgId: "orchard",
						titleContains: "100%_",
					})
				).data.map((row) => row.id),
			).toEqual(["task"]);
			expect(
				(
					await listWorkItemsPage(db, { orgId: "orchard", needsProject: true })
				).data.map((row) => row.id),
			).toEqual(["held"]);
			expect(
				(
					await listOpenWorkItemsAcrossProjects(db, {
						orgId: "orchard",
						projectIds: ["trees"],
					})
				).counts,
			).toEqual([{ projectId: "trees", open: 1 }]);
			expect(
				(
					await getGoalLoopWorkItemSnapshot(db, {
						orgId: "river",
						objectiveId: "missing",
					})
				).total,
			).toBe(0);
			await upsertWorkItemProjection(db, {
				id: "projection",
				orgId: "orchard",
				workItemId: "task",
				provider: "fixture",
				providerState: { revision: 1 },
				createdAt: at,
			});
			expect(await listOrgWorkItemProjections(db, { orgId: "river" })).toEqual({
				data: [],
				total: 0,
			});
			expect(
				(await listOrgWorkItemProjections(db, { orgId: "orchard" })).total,
			).toBe(1);
			const items = coreTable(db, workItems);
			await db
				.update(items)
				.set({ orgId: "orchard" })
				.where(eq(items.id, "foreign"));
			expect((await listWorkItemsPage(db, { orgId: "orchard" })).total).toBe(3);
			expect((await listWorkItemsPage(db, { orgId: "river" })).total).toBe(0);
			await db.delete(items).where(eq(items.id, "foreign"));
			expect((await listWorkItemsPage(db, { orgId: "orchard" })).total).toBe(2);
		});

		it("projects held recovery and native Attempt rows with the same access boundaries", async () => {
			const attempts = await listOrgWorkAttempts(db, {
				orgId: "orchard",
				runtimeStates: ["running"],
			});
			expect(attempts.data).toMatchObject([
				{
					attempt: {
						id: "attempt",
						metadata: { nested: { value: "attempt" } },
					},
					workItem: { id: "task" },
				},
			]);
			expect((await listOrgWorkAttempts(db, { orgId: "river" })).data).toEqual(
				[],
			);
			const recovery = await listOrgWorkRecovery(db, {
				orgId: "orchard",
				observedAt: at,
				signal: "dispatch_held",
			});
			expect(recovery.data).toMatchObject([
				{
					id: "held",
					dispatchHoldReason: "Review dependencies",
					signals: ["dispatch_held"],
				},
			]);
		});

		it("keeps case closure, retained links and cycle checks atomic with Work counts", async () => {
			const cases = coreTable(db, workCases),
				links = coreTable(db, workCaseItems),
				dependencies = coreTable(db, workCaseDependencies),
				items = coreTable(db, workItems),
				counts = coreTable(db, workItemOrgCounts);
			const row = (id: string) => ({
				id,
				orgId: "orchard",
				title: id,
				kind: "delivery",
				accountableOwnerType: "system" as const,
				accountableOwnerId: "tedix",
				openedAt: at,
				createdAt: at,
			});
			await createWorkCase(db, { ...row("first"), now: at });
			await createWorkCase(db, { ...row("second"), now: at });
			expect((await listWorkCases(db, { orgId: "orchard" })).data).toHaveLength(
				2,
			);
			await expect(
				db.insert(cases).values({
					...row("invalid-owner"),
					accountableOwnerId: "unrecognized",
				}),
			).rejects.toThrow();
			const link = {
				id: "link",
				orgId: "orchard",
				caseId: "first",
				workItemId: "held",
				discoveredAt: at,
			};
			await linkWorkItemToCase(db, link);
			expect(
				await detachWorkItemFromCase(db, {
					...link,
					actor: { type: "system", id: "tedix" },
					now: at,
				}),
			).toMatchObject(link);
			await linkWorkItemToCase(db, link);
			await expect(
				db
					.update(cases)
					.set({ stage: "closed", closedAt: at, version: 2 })
					.where(eq(cases.id, "first")),
			).rejects.toThrow();
			await addWorkCaseDependency(db, {
				id: "forward",
				orgId: "orchard",
				prerequisiteCaseId: "first",
				dependentCaseId: "second",
				now: at,
			});
			await expect(
				db.batch([
					db.insert(items).values({
						id: "rollback",
						orgId: "orchard",
						title: "Must roll back",
						admissionSpecRevision: "spec-rollback",
						createdAt: at,
					}),
					db.insert(dependencies).values({
						id: "cycle",
						orgId: "orchard",
						prerequisiteCaseId: "second",
						dependentCaseId: "first",
						createdAt: at,
					}),
				]),
			).rejects.toThrow();
			expect(await getWorkItemById(db, "rollback", "orchard")).toBeNull();
			expect(
				(await db.select().from(counts).where(eq(counts.orgId, "orchard")))[0]
					?.total,
			).toBe(2);
			await db
				.update(items)
				.set({ disposition: "completed", completedAt: at, version: 2 })
				.where(eq(items.id, "held"));
			expect(
				await updateWorkCase(db, {
					orgId: "orchard",
					caseId: "first",
					stage: "closed",
					expectedVersion: 1,
					now: at,
				}),
			).toMatchObject({ stage: "closed", version: 2 });
			await expect(
				db.delete(links).where(eq(links.id, "link")),
			).rejects.toThrow();
			await expect(
				db.delete(dependencies).where(eq(dependencies.id, "forward")),
			).rejects.toThrow();
			await expect(
				db.insert(links).values({
					id: "late-link",
					orgId: "orchard",
					caseId: "first",
					workItemId: "task",
					discoveredAt: at,
				}),
			).rejects.toThrow();
		});
		it("continues bounded recovery pages without losing scopes or reusing a stale checkpoint", async () => {
			await db.insert(coreTable(db, projects)).values(
				["bulk", "bulk-two"].map((id) => ({
					id,
					orgId: "orchard",
					key: id.toUpperCase(),
					name: id,
					leadTediId: "gardener",
					createdAt: at,
				})),
			);
			for (const projectId of ["bulk", "bulk-two"]) {
				const ids = JSON.stringify(
					Array.from(
						{ length: 205 },
						(_, i) => `${projectId}-${i.toString().padStart(4, "0")}`,
					),
				);
				await db.run(sql`INSERT INTO work_items (id,org_id,project_id,title,admission_spec_revision,created_at)
   SELECT value,'orchard',${projectId},'Bulk work','spec-bulk',${at} FROM ${store === "d1" ? sql`json_each(${ids})` : sql`jsonb_array_elements_text(${ids}::jsonb)`}`);
			}
			if (store === "postgres")
				await db.run(sql`SET TIME ZONE 'America/New_York'`);
			const latest = "2026-11-25T14:00:00.000Z";
			await db.insert(coreTable(db, workAgentSessions)).values([
				{
					id: "iso-session",
					organizationId: "orchard",
					userId: "person",
					harness: "codex",
					sessionKey: "iso",
					projectId: "bulk",
					state: "working",
					stateSince: at,
					lastEventAt: "2026-11-25T13:00:00.000Z",
				},
				{
					id: "sql-session",
					organizationId: "orchard",
					userId: "person",
					harness: "codex",
					sessionKey: "sql",
					projectId: "bulk",
					state: "working",
					stateSince: at,
					lastEventAt: "2026-11-25 14:00:00",
				},
				{
					id: "foreign-session",
					organizationId: "river",
					userId: "person",
					harness: "codex",
					sessionKey: "foreign",
					projectId: "bulk",
					state: "working",
					stateSince: at,
					lastEventAt: expires,
				},
			]);
			const inventory = await listContinuityScopes(
				db,
				"",
				"orchard",
				"production",
			);
			expect(
				inventory.find((scope) => scope.key === "project:bulk"),
			).toMatchObject({
				pendingCount: 205,
				hasOwner: 1,
				lastActivityAt: latest,
			});
			expect(
				inventory.find((scope) => scope.key === "project:bulk-two"),
			).toMatchObject({ pendingCount: 205 });
			let cursor: StallRecoveryCursor = { after: "" };
			const recovered = [];
			let ticks = 0;
			do {
				const { scopes, ...next } = await readStallRecoveryPage(
					db,
					cursor,
					"production",
				);
				recovered.push(...scopes);
				cursor = next;
				if (++ticks > 10)
					throw new Error("Recovery cursor did not finish its bounded page");
			} while (cursor.after || cursor.pending?.length);
			expect(
				recovered.filter((scope) => scope.key === "project:bulk"),
			).toMatchObject([{ pendingCount: 205, lastActivityAt: latest }]);
			expect(await getStallRecoveryCheckpoint(db, "production")).toBeNull();
			await advanceStallRecoveryCheckpoint(db, "production", null, "first");
			await advanceStallRecoveryCheckpoint(db, "production", "stale", "wrong");
			expect(await getStallRecoveryCheckpoint(db, "production")).toBe("first");
			await advanceStallRecoveryCheckpoint(db, "production", "first", "second");
			expect(await getStallRecoveryCheckpoint(db, "production")).toBe("second");
			expect(
				await listStallReceipts(
					db,
					"orchard",
					Array.from({ length: 150 }, (_, i) => `project:absent-${i}`),
					"production",
				),
			).toEqual([]);
		});
		it("keeps creation, acceptance and specification events with their versioned mutations", async () => {
			const actor = { type: "system" as const, id: "tedix" };
			const created = await createWorkItem(db, {
				id: "write-task",
				orgId: "orchard",
				projectId: "trees",
				title: "Pick apples",
				accountableOwnerType: "system",
				accountableOwnerId: "tedix",
				createdBy: actor,
				createdAt: at,
				metadata: { nested: { retained: true } },
			});
			expect(created).toMatchObject({
				disposition: "proposed",
				version: 1,
				metadata: { nested: { retained: true } },
			});
			const accepted = await acceptWorkItem(db, {
				orgId: "orchard",
				workItemId: created.id,
				actor,
				acceptedAt: at,
				acceptanceContract: { version: 1, doneLooksLike: "Apples picked" },
			});
			expect(accepted).toMatchObject({ disposition: "accepted", version: 2 });
			const updated = await updateWorkItemSpecification(db, {
				orgId: "orchard",
				workItemId: created.id,
				actor,
				title: "Pick pears",
				expectedWorkItemVersion: 2,
				updatedAt: at,
			});
			expect(updated).toMatchObject({
				title: "Pick pears",
				version: 3,
				metadata: { nested: { retained: true } },
			});
			await expect(
				updateWorkItemSpecification(db, {
					orgId: "orchard",
					workItemId: created.id,
					actor,
					title: "Stale edit",
					expectedWorkItemVersion: 2,
					updatedAt: at,
				}),
			).rejects.toThrow();
			const completed = await completeWorkItem(db, {
				orgId: "orchard",
				workItemId: created.id,
				actor,
				completedAt: at,
				expectedWorkItemVersion: 3,
				closingComment: {
					id: "close-write",
					body: "Pears picked",
					metadata: { harvest: true },
				},
			});
			expect(completed).toMatchObject({
				disposition: "completed",
				version: 4,
				metadata: { completionCommentId: "close-write" },
			});
			expect(
				(
					await completeWorkItem(db, {
						orgId: "orchard",
						workItemId: created.id,
						actor,
						completedAt: at,
					})
				).version,
			).toBe(4);
			await createWorkItem(db, {
				id: "cancel-task",
				orgId: "orchard",
				title: "Cancel proposal",
				createdAt: at,
			});
			await db.insert(coreTable(db, workItemComments)).values({
				id: "quiet-comment",
				orgId: "orchard",
				workItemId: "cancel-task",
				authorType: "user",
				authorId: "person",
				body: "Older comment",
				createdAt: "2026-11-23 10:00:00",
			});
			expect(
				await cancelWorkItem(db, {
					orgId: "orchard",
					workItemId: "cancel-task",
					actor,
					cancelledAt: at,
					reason: "No longer needed",
					hygiene: { humanQuietHours: 48, noAttempts: true },
				}),
			).toMatchObject({ disposition: "cancelled", version: 2 });

			expect(
				(
					await listWorkActivity(db, {
						orgId: "orchard",
						workItemId: created.id,
						afterSequence: 0,
					})
				).events.map((event) => event.eventType),
			).toEqual([
				"work.created",
				"work.accepted",
				"work.specification_updated",
				"work.completed",
			]);
			const events = await db.all<{ event_type: string; payload: unknown }>(
				sql`SELECT event_type,payload FROM work_events WHERE org_id='orchard' AND work_item_id='write-task' ORDER BY sequence`,
			);
			expect(
				events.map((event) => [
					event.event_type,
					typeof event.payload === "string"
						? JSON.parse(event.payload)
						: event.payload,
				]),
			).toEqual([
				["work.created", { workItemVersion: 1 }],
				["work.accepted", { workItemVersion: 2 }],
				[
					"work.specification_updated",
					{ workItemVersion: 3, ownerStarted: false },
				],
				["work.completed", { workItemVersion: 4 }],
			]);
		});
		it("creates admitted children with inherited resources and cases, and atomically refuses budget overflow", async () => {
			const terms = {
				version: 2 as const,
				goal: "Pick fruit",
				successCriterion: [{ path: ["ok"], equals: true }],
				budget: { maxTokens: 10, maxCostUsd: 1 },
				remainingDepth: 1,
				errorAllowance: 0,
				returnFormat: {
					type: "object" as const,
					properties: { ok: { type: "boolean" as const } },
					required: ["ok"],
					additionalProperties: false as const,
				},
				deadline: expires,
			};
			const items = coreTable(db, workItems),
				events = coreTable(db, workEvents),
				requirements = coreTable(db, workResourceRequirements),
				links = coreTable(db, workCaseItems);
			await db
				.update(coreTable(db, organizations))
				.set({ metadata: { workDelegation: { approvalMode: "auto" } } })
				.where(eq(coreTable(db, organizations).id, "orchard"));
			await db.insert(items).values({
				id: "parent",
				orgId: "orchard",
				title: "Parent",
				disposition: "accepted",
				admissionSpecRevision: "parent-spec",
				acceptanceContract: {
					version: 1,
					doneLooksLike: terms.goal,
					taskContract: terms,
				},
				createdAt: at,
			});
			await db.insert(coreTable(db, workAdmissions)).values({
				id: "parent-admission",
				orgId: "orchard",
				workItemId: "parent",
				workItemVersion: 1,
				admissionSpecRevision: "parent-spec",
				executorType: "tedi",
				executorId: "gardener",
				decision: "admitted",
				decidedAt: at,
				expiresAt: expires,
				createdAt: at,
			});
			await db.insert(events).values({
				id: "parent-admission",
				orgId: "orchard",
				workItemId: "parent",
				eventType: "admission.task_contract",
				actorType: "tedi",
				actorId: "gardener",
				payload: { taskContract: terms },
				occurredAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id: "parent-attempt",
				orgId: "orchard",
				workItemId: "parent",
				admissionId: "parent-admission",
				executorType: "tedi",
				executorId: "gardener",
				attemptNumber: 1,
				runtimeState: "running",
				startedAt: at,
				heartbeatAt: at,
				expiresAt: expires,
			});
			await db.insert(coreTable(db, workResourcePools)).values({
				id: "basket",
				orgId: "orchard",
				resourceKey: "basket",
				allocationMode: "capacity",
				capacity: 10,
				createdAt: at,
			});
			await db.insert(requirements).values({
				orgId: "orchard",
				workItemId: "parent",
				resourceKey: "basket",
				quantity: 2,
				createdAt: at,
				updatedAt: at,
			});
			for (const caseId of ["child-case-a", "child-case-b"]) {
				await createWorkCase(db, {
					id: caseId,
					orgId: "orchard",
					title: caseId,
					kind: "delivery",
					accountableOwnerType: "system",
					accountableOwnerId: "tedix",
					openedAt: at,
					now: at,
				});
				await linkWorkItemToCase(db, {
					id: caseId,
					orgId: "orchard",
					caseId,
					workItemId: "parent",
					discoveredAt: at,
				});
			}
			const parent = (await getWorkItemById(db, "parent", "orchard"))!;
			const input = CreateWorkItemInputSchema.parse({
				title: "Child",
				taskContract: {
					...terms,
					remainingDepth: 0,
					budget: { maxTokens: 6, maxCostUsd: 0.6 },
				},
				blockedByWorkItemIds: [],
			});
			input.blockedByWorkItemIds = ["task", "held", "task"];
			const batches = vi.spyOn(db, "batch");
			const child = (await createChildWorkItem(db, {
				input,
				parent,
				actor: { type: "tedi", id: "gardener" },
				now: at,
			}))!;
			expect(batches).toHaveBeenCalledTimes(1);
			batches.mockRestore();
			expect(
				await inheritedChildAuthority(db, child, {
					type: "tedi",
					id: "gardener",
				}),
			).toBe(true);
			await expect(
				workDelegationAncestors(db, { ...child, parentWorkItemId: child.id }),
			).rejects.toThrow("Invalid Work delegation ancestry");
			await expect(
				workDelegationAncestors(db, { ...child, orgId: "river" }),
			).rejects.toThrow("Invalid Work delegation ancestry");
			expect(child).toMatchObject({
				disposition: "accepted",
				parentWorkItemId: parent.id,
				acceptanceContract: { taskContract: input.taskContract },
			});
			expect(child.admissionSpecRevision).toBeTruthy();
			expect(await taskContractRefusal(db, child, at)).toBeUndefined();
			expect(
				await db
					.select()
					.from(requirements)
					.where(eq(requirements.workItemId, child.id)),
			).toMatchObject([{ resourceKey: "basket", quantity: 2 }]);
			const inherited = await db
				.select()
				.from(links)
				.where(eq(links.workItemId, child.id));
			expect(inherited.map((row) => row.caseId).sort()).toEqual([
				"child-case-a",
				"child-case-b",
			]);
			expect(new Set(inherited.map((row) => row.id)).size).toBe(2);
			expect(
				await db
					.select()
					.from(coreTable(db, workItemRelations))
					.where(eq(coreTable(db, workItemRelations).toWorkItemId, child.id)),
			).toHaveLength(2);
			await expect(
				createChildWorkItem(db, {
					input,
					parent,
					actor: { type: "tedi", id: "gardener" },
					now: at,
				}),
			).rejects.toThrow();
			expect(
				await db
					.select()
					.from(items)
					.where(eq(items.parentWorkItemId, parent.id)),
			).toHaveLength(1);
			expect(
				await db.select().from(events).where(eq(events.workItemId, child.id)),
			).toHaveLength(1);
		});
	});
