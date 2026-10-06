import { and, desc, eq, isNull } from "drizzle-orm";
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
