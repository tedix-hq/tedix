import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	calendarCoordinatorConfigurations as configurations,
	calendarCoordinatorPlans as plans,
	calendarCoordinatorMirrors as mirrors,
	calendarCoordinatorMutations as mutations,
} from "../schema/calendar-coordinator";
type Scope = { organizationId: string; configurationId: string };
const scoped = (s: Scope) =>
	and(
		eq(configurations.organizationId, s.organizationId),
		eq(configurations.id, s.configurationId),
	);
export async function getCalendarCoordinator(db: DbQueryClient, s: Scope) {
	return (await db.select().from(configurations).where(scoped(s)).limit(1))[0];
}
export async function listCalendarCoordinators(
	db: DbQueryClient,
	organizationId: string,
	workspaceId: string,
) {
	return db
		.select()
		.from(configurations)
		.where(
			and(
				eq(configurations.organizationId, organizationId),
				eq(configurations.workspaceId, workspaceId),
			),
		)
		.orderBy(desc(configurations.updatedAt))
		.limit(100);
}
export async function createCalendarCoordinator(
	db: DbQueryClient,
	row: typeof configurations.$inferInsert,
) {
	return (await db.insert(configurations).values(row).returning())[0];
}
export async function updateCalendarCoordinator(
	db: DbQueryClient,
	s: Scope,
	expectedRevision: number,
	patch: Pick<typeof configurations.$inferInsert, "configuration" | "mode">,
	now = Date.now(),
) {
	return (
		await db
			.update(configurations)
			.set({
				...patch,
				revision: expectedRevision + 1,
				updatedAt: new Date(now).toISOString(),
			})
			.where(
				and(
					scoped(s),
					eq(configurations.revision, expectedRevision),
					lte(configurations.leaseUntil, now),
				),
			)
			.returning()
	)[0];
}
export async function acquireCalendarCoordinatorLease(
	db: DbQueryClient,
	s: Scope,
	revision: number,
	leaseId: string,
	now: number,
) {
	return (
		await db
			.update(configurations)
			.set({
				leaseId,
				leaseUntil: now + 120_000,
				fence: sql`${configurations.fence}+1`,
			})
			.where(
				and(
					scoped(s),
					eq(configurations.revision, revision),
					eq(configurations.mode, "active"),
					lte(configurations.leaseUntil, now),
				),
			)
			.returning()
	)[0];
}
export async function renewCalendarCoordinatorLease(
	db: DbQueryClient,
	s: Scope,
	revision: number,
	leaseId: string,
	fence: number,
	now: number,
) {
	return (
		await db
			.update(configurations)
			.set({ leaseUntil: now + 120_000 })
			.where(
				and(
					scoped(s),
					eq(configurations.revision, revision),
					eq(configurations.mode, "active"),
					eq(configurations.leaseId, leaseId),
					eq(configurations.fence, fence),
					sql`${configurations.leaseUntil}>${now}`,
				),
			)
			.returning()
	)[0];
}
export async function releaseCalendarCoordinatorLease(
	db: DbQueryClient,
	s: Scope,
	leaseId: string,
	fence: number,
	receipt: string,
	succeeded = false,
) {
	return (
		await db
			.update(configurations)
			.set({
				leaseId: null,
				leaseUntil: 0,
				lastReceipt: receipt,
				...(succeeded
					? { lastSuccessfulReconcileAt: new Date().toISOString() }
					: {}),
			})
			.where(
				and(
					scoped(s),
					eq(configurations.leaseId, leaseId),
					eq(configurations.fence, fence),
				),
			)
			.returning()
	)[0];
}
/** Disable immediately revokes any in-flight fence. Subsequent writes fail their precondition. */
export async function disableCalendarCoordinator(
	db: DbQueryClient,
	s: Scope,
	revision: number,
	configuration: string,
) {
	return (
		await db
			.update(configurations)
			.set({
				mode: "preview",
				configuration,
				revision: revision + 1,
				leaseId: null,
				leaseUntil: 0,
				fence: sql`${configurations.fence}+1`,
				updatedAt: new Date().toISOString(),
			})
			.where(and(scoped(s), eq(configurations.revision, revision)))
			.returning()
	)[0];
}
export async function saveCalendarCoordinatorPlan(
	db: DbQueryClient,
	row: typeof plans.$inferInsert,
) {
	return (await db.insert(plans).values(row).returning())[0];
}
export async function getCalendarCoordinatorPlan(
	db: DbQueryClient,
	s: Scope,
	id: string,
) {
	return (
		await db
			.select()
			.from(plans)
			.where(
				and(
					eq(plans.organizationId, s.organizationId),
					eq(plans.configurationId, s.configurationId),
					eq(plans.id, id),
				),
			)
			.limit(1)
	)[0];
}
export async function listCalendarCoordinatorMirrors(
	db: DbQueryClient,
	s: Scope,
) {
	return db
		.select()
		.from(mirrors)
		.where(
			and(
				eq(mirrors.organizationId, s.organizationId),
				eq(mirrors.configurationId, s.configurationId),
			),
		)
		.limit(10_001);
}
export async function listCalendarCoordinatorMutations(
	db: DbQueryClient,
	s: Scope,
) {
	return db
		.select()
		.from(mutations)
		.where(
			and(
				eq(mutations.organizationId, s.organizationId),
				eq(mutations.configurationId, s.configurationId),
			),
		)
		.limit(10_001);
}
/** A live lease fences the ledger statement itself, not merely an earlier app read. */
export async function putCalendarCoordinatorMutation(
	db: DbQueryClient,
	s: Scope,
	leaseId: string,
	fence: number,
	row: typeof mutations.$inferInsert,
	now = Date.now(),
) {
	const selected = db
		.select({
			id: sql<string>`${row.id}`.as("id"),
			organizationId: sql<string>`${s.organizationId}`.as("organizationId"),
			configurationId: sql<string>`${s.configurationId}`.as("configurationId"),
			planId: sql<string>`${row.planId}`.as("planId"),
			actionId: sql<string>`${row.actionId}`.as("actionId"),
			state: sql<string>`${row.state}`.as("state"),
			mutation: sql<string>`${row.mutation}`.as("mutation"),
			updatedAt: sql<string>`${row.updatedAt}`.as("updatedAt"),
		})
		.from(configurations)
		.where(
			and(
				scoped(s),
				eq(configurations.leaseId, leaseId),
				eq(configurations.fence, fence),
				eq(configurations.mode, "active"),
				sql`${configurations.leaseUntil}>${now}`,
			),
		);
	return db
		.insert(mutations)
		.select(selected)
		.onConflictDoUpdate({
			target: [mutations.configurationId, mutations.actionId],
			set: {
				state: row.state,
				mutation: row.mutation,
				updatedAt: row.updatedAt,
			},
		})
		.returning();
}
export async function putCalendarCoordinatorMirror(
	db: DbQueryClient,
	s: Scope,
	leaseId: string,
	fence: number,
	row: typeof mirrors.$inferInsert,
	now = Date.now(),
) {
	const selected = db
		.select({
			id: sql<string>`${row.id}`.as("id"),
			organizationId: sql<string>`${s.organizationId}`.as("organizationId"),
			configurationId: sql<string>`${s.configurationId}`.as("configurationId"),
			sourceKey: sql<string>`${row.sourceKey}`.as("sourceKey"),
			destinationKey: sql<string>`${row.destinationKey}`.as("destinationKey"),
			mirror: sql<string>`${row.mirror}`.as("mirror"),
		})
		.from(configurations)
		.where(
			and(
				scoped(s),
				eq(configurations.leaseId, leaseId),
				eq(configurations.fence, fence),
				eq(configurations.mode, "active"),
				sql`${configurations.leaseUntil}>${now}`,
			),
		);
	return db
		.insert(mirrors)
		.select(selected)
		.onConflictDoUpdate({
			target: [
				mirrors.configurationId,
				mirrors.sourceKey,
				mirrors.destinationKey,
			],
			set: { mirror: row.mirror },
		})
		.returning();
}
export async function removeCalendarCoordinatorMirror(
	db: DbQueryClient,
	s: Scope,
	id: string,
	leaseId: string,
	fence: number,
	now = Date.now(),
) {
	return db
		.delete(mirrors)
		.where(
			and(
				eq(mirrors.organizationId, s.organizationId),
				eq(mirrors.configurationId, s.configurationId),
				eq(mirrors.id, id),
				sql`EXISTS(SELECT 1 FROM ${configurations} WHERE ${configurations.id}=${s.configurationId} AND ${configurations.organizationId}=${s.organizationId} AND ${configurations.leaseId}=${leaseId} AND ${configurations.fence}=${fence} AND ${configurations.mode}='active' AND ${configurations.leaseUntil}>${now})`,
			),
		)
		.returning();
}
/** Subscription ids are server-installed references, never accepted as account selectors. */
export async function getCalendarCoordinatorForSubscription(
	db: DbQueryClient,
	organizationId: string,
	subscriptionId: string,
) {
	const rows = await db
		.select()
		.from(configurations)
		.where(
			and(
				eq(configurations.organizationId, organizationId),
				eq(configurations.mode, "active"),
				sql`EXISTS(SELECT 1 FROM json_each(json_extract(${configurations.configuration}, '$.subscriptionIds')) WHERE value=${subscriptionId})`,
			),
		)
		.limit(2);
	if (rows.length > 1)
		throw new Error("Calendar subscription binding is ambiguous");
	return rows[0];
}
