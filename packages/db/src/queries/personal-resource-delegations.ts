import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	personalResourceDelegations,
	type NewPersonalResourceDelegationRow,
} from "../schema/personal-resource-delegations";

export async function createPersonalResourceDelegation(
	db: DbQueryClient,
	row: NewPersonalResourceDelegationRow,
) {
	const [created] = await db
		.insert(personalResourceDelegations)
		.values(row)
		.returning();
	if (!created)
		throw new Error("Personal resource consent insert returned no row");
	return created;
}
export async function getPersonalResourceDelegation(
	db: DbQueryClient,
	input: { organizationId: string; id: string },
) {
	const [row] = await db
		.select()
		.from(personalResourceDelegations)
		.where(
			and(
				eq(personalResourceDelegations.organizationId, input.organizationId),
				eq(personalResourceDelegations.id, input.id),
			),
		)
		.limit(1);
	return row;
}
export async function listPersonalResourceDelegations(
	db: DbQueryClient,
	input: { organizationId: string; ownerUserId: string; limit?: number },
) {
	return db
		.select()
		.from(personalResourceDelegations)
		.where(
			and(
				eq(personalResourceDelegations.organizationId, input.organizationId),
				eq(personalResourceDelegations.ownerUserId, input.ownerUserId),
			),
		)
		.orderBy(
			desc(personalResourceDelegations.createdAt),
			desc(personalResourceDelegations.id),
		)
		.limit(Math.min(100, Math.max(1, input.limit ?? 50)));
}
/** Newest active consent per resource for this worker skill, across revisions. */
export async function listActiveSkillPersonalResourceDelegations(
	db: DbQueryClient,
	input: {
		organizationId: string;
		tediId: string;
		skillId: string;
		now: string;
	},
) {
	const ranked = db
		.select({
			id: personalResourceDelegations.id,
			rank: sql<number>`row_number() over (
				partition by ${personalResourceDelegations.resourceId}
				order by ${personalResourceDelegations.createdAt} desc, ${personalResourceDelegations.id} desc
			)`.as("resource_rank"),
		})
		.from(personalResourceDelegations)
		.where(
			and(
				eq(personalResourceDelegations.organizationId, input.organizationId),
				eq(personalResourceDelegations.tediId, input.tediId),
				eq(personalResourceDelegations.skillId, input.skillId),
				isNull(personalResourceDelegations.revokedAt),
				gt(personalResourceDelegations.expiresAt, input.now),
			),
		)
		.as("ranked_personal_consents");
	return db
		.select()
		.from(personalResourceDelegations)
		.where(
			// bound-params: SQL subquery binds only scope, time, and rank, not one parameter per grant.
			inArray(
				personalResourceDelegations.id,
				db.select({ id: ranked.id }).from(ranked).where(eq(ranked.rank, 1)),
			),
		)
		.orderBy(
			desc(personalResourceDelegations.createdAt),
			desc(personalResourceDelegations.id),
		)
		.limit(20);
}
/** Unrevoked, unexpired consents one owner gave this worker skill, at any revision. */
export async function listActiveOwnerSkillPersonalResourceDelegations(
	db: DbQueryClient,
	input: {
		organizationId: string;
		ownerUserId: string;
		tediId: string;
		skillId: string;
		now: string;
	},
) {
	return db
		.select()
		.from(personalResourceDelegations)
		.where(
			and(
				eq(personalResourceDelegations.organizationId, input.organizationId),
				eq(personalResourceDelegations.ownerUserId, input.ownerUserId),
				eq(personalResourceDelegations.tediId, input.tediId),
				eq(personalResourceDelegations.skillId, input.skillId),
				isNull(personalResourceDelegations.revokedAt),
				gt(personalResourceDelegations.expiresAt, input.now),
			),
		)
		.orderBy(desc(personalResourceDelegations.createdAt))
		.limit(20);
}
/** Revocation is monotonic and idempotent; no API restores consent. */
export async function revokePersonalResourceDelegation(
	db: DbQueryClient,
	input: {
		organizationId: string;
		ownerUserId: string;
		id: string;
		revokedAt: string;
	},
) {
	await db
		.update(personalResourceDelegations)
		.set({ revokedAt: input.revokedAt })
		.where(
			and(
				eq(personalResourceDelegations.organizationId, input.organizationId),
				eq(personalResourceDelegations.ownerUserId, input.ownerUserId),
				eq(personalResourceDelegations.id, input.id),
				isNull(personalResourceDelegations.revokedAt),
			),
		);
	const row = await getPersonalResourceDelegation(db, input);
	return row?.ownerUserId === input.ownerUserId ? row : undefined;
}
