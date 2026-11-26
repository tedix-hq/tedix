import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { jsonType } from "../../core-store/dialect";
import { createDbQueryClient, type DbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import { organizations } from "../../schema/organizations";
import { organizationMembers } from "../../schema/organization-members";
import { tedis } from "../../schema/tedis";
import { tediApprovalRequests } from "../../schema/approvals";
import {
	workItems,
	workEvents,
	workAttempts,
	workItemComments,
	workAttemptMessages,
} from "../../schema/work-items";
import {
	workAdmissions,
	workApprovalProposals,
	workApprovalDecisions,
} from "../../schema/work-factory";
import {
	workAttemptLimitAvailable,
	laneDispatchHasNoSettledResult,
} from "./attempt-limit";
import {
	planningApprovalVersion,
	ownerWorkDelegation,
	hasOwnerWorkDelegation,
	matchesWorkApprovalVersion,
	ownerWorkApprovalIsCurrent,
	ownerWorkApprovalStatements,
} from "./planning-approval";
import { childReportStatements } from "./child-delegation";
import { findWorkToolApprovalWait } from "./tool-approval-wait";

const at = "2026-11-25T12:00:00.000Z";
const expires = "2026-11-26T12:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
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
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "orchard",
					name: "Orchard",
					slug: "orchard",
					metadata: { defaultApprovalMode: "ask_every_time" },
				},
				{ id: "river", name: "River", slug: "river" },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "gardener",
				organizationId: "orchard",
				name: "Gardener",
				slug: "gardener",
			});
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "member",
				organizationId: "orchard",
				userId: "owner",
				descopeUserId: "subject",
				email: "owner@example.test",
				role: "owner",
				status: "active",
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		const item = async (
			id: string,
			values: Partial<typeof workItems.$inferInsert> = {},
		) => {
			const [row] = await db
				.insert(coreTable(db, workItems))
				.values({
					id,
					orgId: "orchard",
					title: id,
					disposition: "accepted",
					admissionSpecRevision: `spec-${id}`,
					accountableOwnerType: "user",
					accountableOwnerId: "owner",
					createdAt: at,
					...values,
				})
				.returning();
			return row!;
		};
		const event = async (
			id: string,
			workItemId: string,
			payload: typeof workEvents.$inferInsert.payload,
			occurredAt = at,
			actorId = "owner",
			orgId = "orchard",
		) => {
			await db.insert(coreTable(db, workEvents)).values({
				id,
				orgId,
				workItemId,
				eventType: "work.specification_updated",
				actorType: "user",
				actorId,
				payload,
				occurredAt,
			});
		};
		const attempt = async (
			id: string,
			workItemId: string,
			outcome: "failed" | "cancelled" | "rejected" | "succeeded",
			metadata = {},
			attemptNumber = 1,
		) => {
			const receipt = `grant-${id}`;
			await db.insert(coreTable(db, workAdmissions)).values({
				id: receipt,
				orgId: "orchard",
				workItemId,
				workItemVersion: 1,
				admissionSpecRevision: `spec-${workItemId}`,
				executorType: "tedi",
				executorId: "gardener",
				decision: "admitted",
				decidedAt: at,
				expiresAt: expires,
				createdAt: at,
			});
			await db.insert(coreTable(db, workAttempts)).values({
				id,
				orgId: "orchard",
				workItemId,
				admissionId: receipt,
				executorType: "tedi",
				executorId: "gardener",
				attemptNumber,
				runtimeState: "finished",
				outcome,
				startedAt: at,
				heartbeatAt: at,
				expiresAt: expires,
				finishedAt: at,
				metadata,
			});
		};
		const available = async (id: string) => {
			const table = coreTable(db, workItems);
			const [row] = await db
				.select({ available: workAttemptLimitAvailable(db).as("available") })
				.from(table)
				.where(eq(table.id, id));
			return Boolean(row?.available);
		};
		it("keeps ordinary retry grants distinct from the factory cap and JSON null", async () => {
			await item("ordinary", { maxAttempts: 1 });
			await item("factory", { maxAttempts: 1, metadata: { factoryCycle: {} } });
			await item("invalid", {
				maxAttempts: 1,
				metadata: { factoryCycle: null },
			});
			expect(await available("ordinary")).toBe(true);
			expect(await available("factory")).toBe(true);
			expect(await available("invalid")).toBe(false);
			await attempt("ordinary-failed", "ordinary", "failed");
			await attempt("factory-cancelled", "factory", "cancelled");
			expect(await available("ordinary")).toBe(false);
			expect(await available("factory")).toBe(false);
			await db.insert(coreTable(db, workEvents)).values(
				["ordinary", "factory"].map((id) => ({
					id: `extra-${id}`,
					orgId: "orchard",
					workItemId: id,
					eventType: "lane.attempt_granted",
					actorType: "user" as const,
					actorId: "owner",
					occurredAt: at,
				})),
			);
			expect(await available("ordinary")).toBe(true);
			expect(await available("factory")).toBe(false);
			await item("cancelled", { maxAttempts: 1 });
			await attempt("cancelled-run", "cancelled", "cancelled");
			expect(await available("cancelled")).toBe(true);
			await item("rejected", { maxAttempts: 1 });
			await attempt("rejected-run", "rejected", "rejected");
			expect(await available("rejected")).toBe(true);
		});
		it("blocks a settled current specification until a later decision continuation", async () => {
			await item("settled");
			await attempt("settled-run", "settled", "succeeded");
			const table = coreTable(db, workItems);
			const read = async () =>
				Boolean(
					(
						await db
							.select({
								available: laneDispatchHasNoSettledResult(db).as("available"),
							})
							.from(table)
							.where(eq(table.id, "settled"))
					)[0]?.available,
				);
			expect(await read()).toBe(false);
			await db
				.update(table)
				.set({ metadata: { decisionContinuation: { at: expires } } })
				.where(eq(table.id, "settled"));
			expect(await read()).toBe(true);
		});
		it("honors planning continuity and the exact owner receipt window in correlated projections", async () => {
			const row = await item("planning", { version: 2 });
			await event("continuity", row.id, {
				workItemVersion: 2,
				ownerStarted: true,
				planningApproval: {
					fromVersion: 1,
					toVersion: 2,
					admissionSpecRevision: row.admissionSpecRevision,
				},
			});
			const table = coreTable(db, workItems);
			const [projection] = await db
				.select({
					version: planningApprovalVersion(db, table).as("reviewed_version"),
					delegated: ownerWorkDelegation(db, table, at).as("delegated"),
				})
				.from(table)
				.where(eq(table.id, row.id));
			expect(projection?.version).toBe(1);
			expect(Boolean(projection?.delegated)).toBe(true);
			expect(await hasOwnerWorkDelegation(db, row, expires)).toBe(false);
			expect(
				await hasOwnerWorkDelegation(db, row, "2026-11-25T11:59:59.999Z"),
			).toBe(false);
			await item("wrong-owner");
			await event(
				"wrong-receipt",
				"wrong-owner",
				{ workItemVersion: 1, ownerStarted: true },
				at,
				"someone",
			);
			const [wrong] = await db
				.select()
				.from(table)
				.where(eq(table.id, "wrong-owner"));
			expect(await hasOwnerWorkDelegation(db, wrong!, at)).toBe(false);
			await item("foreign-owner", { orgId: "river" });
			await event(
				"foreign-receipt",
				"foreign-owner",
				{ workItemVersion: 1, ownerStarted: true },
				at,
				"owner",
				"river",
			);
			expect(
				await hasOwnerWorkDelegation(
					db,
					{ ...wrong!, id: "foreign-owner" },
					at,
				),
			).toBe(false);
		});
		it("composes owner approval writes after their lifecycle event and rejects stale owner approvals", async () => {
			const row = await item("approval", { riskLevel: "high" });
			await db.batch([
				db.insert(coreTable(db, workEvents)).values({
					id: "owner-start",
					orgId: "orchard",
					workItemId: row.id,
					eventType: "work.accepted",
					actorType: "user",
					actorId: "owner",
					payload: { workItemVersion: 1 },
					occurredAt: at,
				}),
				...ownerWorkApprovalStatements(db, row, at),
			]);
			const proposals = coreTable(db, workApprovalProposals);
			const decisions = coreTable(db, workApprovalDecisions);
			expect(await db.select().from(decisions)).toHaveLength(1);
			const read = (now: string) =>
				db
					.select({ id: proposals.id })
					.from(proposals)
					.where(
						and(
							eq(proposals.workItemId, row.id),
							matchesWorkApprovalVersion(db, row),
							ownerWorkApprovalIsCurrent(db, row, now),
						),
					);
			expect(await read(at)).toHaveLength(1);
			expect(await read(expires)).toHaveLength(0);
		});
		it("reports only the winning child settlement, with idempotent comments and native boolean messages", async () => {
			await item("parent");
			await attempt("parent-run", "parent", "failed");
			await item("child", {
				parentWorkItemId: "parent",
				metadata: { childDelegation: { parentAttemptId: "parent-run" } },
			});
			await attempt("child-run", "child", "succeeded");
			const p = {
				orgId: "orchard",
				workItemId: "child",
				attemptId: "child-run",
				settledVersion: 1,
				outcome: "succeeded",
				now: at,
			};
			await db.batch(childReportStatements(db, { ...p, settledVersion: 2 }));
			const comments = coreTable(db, workItemComments);
			const messages = coreTable(db, workAttemptMessages);
			expect(await db.select().from(comments)).toHaveLength(0);
			await db.batch(childReportStatements(db, p));
			await db.batch(childReportStatements(db, p));
			expect(await db.select().from(comments)).toMatchObject([
				{
					workItemId: "parent",
					metadata: { childWorkItemId: "child", childAttemptId: "child-run" },
				},
			]);
			expect(await db.select().from(messages)).toMatchObject([
				{ workItemId: "parent", attemptId: "parent-run", interrupt: false },
			]);
		});
		it("parks only matching unexecuted tool approvals, including suspended attempts", async () => {
			await item("tool");
			await attempt("tool-run", "tool", "cancelled", {
				dispatchVersion: 1,
				approvalWait: { id: "tool-request" },
			});
			const requests = coreTable(db, tediApprovalRequests);
			const payload = {
				workItemId: "tool",
				requestingWorkVersion: 1,
				requestingAgent: { principalId: "gardener" },
				requestingAttemptId: "tool-run",
			};
			await db.insert(requests).values({
				id: "tool-request",
				orgId: "orchard",
				tediId: "gardener",
				actionType: "mcp.tool_call",
				description: "Call",
				payload,
				createdAt: at,
				expiresAt: expires,
			});
			const p = {
				orgId: "orchard",
				workItemId: "tool",
				workVersion: 1,
				now: at,
			};
			expect((await findWorkToolApprovalWait(db, p))?.id).toBe("tool-request");
			expect(
				await findWorkToolApprovalWait(db, { ...p, attemptId: "other" }),
			).toBeUndefined();
			expect(
				await findWorkToolApprovalWait(db, { ...p, workVersion: 2 }),
			).toBeUndefined();
			await db
				.update(requests)
				.set({
					status: "approved",
					payload: { ...payload, execution: { status: "executed" } },
				})
				.where(eq(requests.id, "tool-request"));
			expect(await findWorkToolApprovalWait(db, p)).toBeUndefined();
		});
		it("distinguishes absent JSON from null and scalar types", async () => {
			const table = coreTable(db, workItems);
			await item("json-types", {
				metadata: {
					nil: null,
					string: "x",
					number: 2,
					boolean: false,
					object: {},
					array: [],
				},
			});
			const [row] = await db
				.select({
					absent: jsonType(db, table.metadata, ["absent"]).as("absent"),
					nil: jsonType(db, table.metadata, ["nil"]).as("nil"),
					string: jsonType(db, table.metadata, ["string"]).as("string"),
					number: jsonType(db, table.metadata, ["number"]).as("number"),
					boolean: jsonType(db, table.metadata, ["boolean"]).as("boolean"),
					object: jsonType(db, table.metadata, ["object"]).as("object"),
					array: jsonType(db, table.metadata, ["array"]).as("array"),
				})
				.from(table)
				.where(eq(table.id, "json-types"));
			expect(row).toEqual({
				absent: null,
				nil: "null",
				string: "string",
				number: "number",
				boolean: "boolean",
				object: "object",
				array: "array",
			});
		});
	});
