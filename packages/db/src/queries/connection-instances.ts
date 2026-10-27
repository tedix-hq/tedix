import {
	ConnectionAllowedResourcesSchema,
	type ConnectionAllowedResources,
} from "@tedix/api-contract/schemas/connections";
import { organizations } from "../schema/organizations";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { connectionInstances } from "../schema/connection-instances";

export type ConnectionOwner =
	| { userId: string; organizationId?: never }
	| { organizationId: string; userId?: never };

function ownerPredicate(owner: ConnectionOwner) {
	return owner.organizationId
		? eq(connectionInstances.organizationId, owner.organizationId)
		: and(
				eq(connectionInstances.ownerUserId, owner.userId!),
				isNull(connectionInstances.organizationId),
			);
}

export async function listConnectionInstances(
	db: DbQueryClient,
	owner: ConnectionOwner,
) {
	return db
		.select()
		.from(connectionInstances)
		.where(ownerPredicate(owner))
		.orderBy(asc(connectionInstances.createdAt), asc(connectionInstances.id))
		.limit(100);
}

export async function getConnectionInstance(
	db: DbQueryClient,
	owner: ConnectionOwner,
	id: string,
	providerId: string,
) {
	const rows = await db
		.select()
		.from(connectionInstances)
		.where(
			and(
				eq(connectionInstances.id, id),
				ownerPredicate(owner),
				eq(connectionInstances.providerId, providerId),
			),
		)
		.limit(1);
	return rows[0];
}

export async function createConnectionInstance(
	db: DbQueryClient,
	params: {
		id: string;
		ownerUserId: string;
		organizationId?: string;
		providerId: string;
		label: string;
		ownerTeam?: string;
		justification?: string;
		dataSensitivity?: typeof connectionInstances.$inferInsert.dataSensitivity;
		allowedResources?: typeof connectionInstances.$inferInsert.allowedResources;
	},
) {
	const now = new Date().toISOString();
	const rows = await db
		.insert(connectionInstances)
		.values({ ...params, tokenIds: [], createdAt: now, updatedAt: now })
		.returning();
	return rows[0]!;
}

/** Organization-scoped resource changes take effect on the next credential lookup. */
export async function setConnectionAllowedResources(
	db: DbQueryClient,
	organizationId: string,
	id: string,
	providerId: string,
	allowedResources: typeof connectionInstances.$inferInsert.allowedResources,
) {
	return db
		.update(connectionInstances)
		.set({ allowedResources, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(connectionInstances.id, id),
				eq(connectionInstances.organizationId, organizationId),
				eq(connectionInstances.providerId, providerId),
			),
		)
		.returning();
}

export async function renameConnectionInstance(
	db: DbQueryClient,
	owner: ConnectionOwner,
	id: string,
	label: string,
) {
	return db
		.update(connectionInstances)
		.set({ label, updatedAt: new Date().toISOString() })
		.where(and(eq(connectionInstances.id, id), ownerPredicate(owner)))
		.returning();
}

/** Atomically pin subject and record exact grant IDs; concurrent reads cannot lose receipts. */
export async function recordConnectionGrant(
	db: DbQueryClient,
	params: {
		owner: ConnectionOwner;
		id: string;
		providerId: string;
		tokenId: string;
		tokenSub?: string;
	},
) {
	return db
		.update(connectionInstances)
		.set({
			tokenIds: sql`CASE WHEN EXISTS (SELECT 1 FROM json_each(${connectionInstances.tokenIds}) WHERE value = ${params.tokenId}) THEN ${connectionInstances.tokenIds} ELSE json_insert(${connectionInstances.tokenIds}, '$[#]', ${params.tokenId}) END`,
			...(params.tokenSub
				? {
						tokenSub: sql`coalesce(${connectionInstances.tokenSub}, ${params.tokenSub})`,
					}
				: {}),
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(connectionInstances.id, params.id),
				ownerPredicate(params.owner),
				eq(connectionInstances.providerId, params.providerId),
				...(params.tokenSub
					? [
							or(
								isNull(connectionInstances.tokenSub),
								eq(connectionInstances.tokenSub, params.tokenSub),
							),
						]
					: []),
			),
		)
		.returning();
}

export async function clearConnectionGrants(
	db: DbQueryClient,
	owner: ConnectionOwner,
	id: string,
) {
	// Keep the slot and subject pin so reconnect cannot silently switch identities.
	return db
		.update(connectionInstances)
		.set({ tokenIds: [], updatedAt: new Date().toISOString() })
		.where(and(eq(connectionInstances.id, id), ownerPredicate(owner)))
		.returning();
}

/** Provider limits also cover default API-key connections and every named account. */
export async function getOrganizationConnectionAllowedResources(
	db: DbQueryClient,
	organizationId: string,
	providerId: string,
): Promise<ConnectionAllowedResources | null> {
	const path = `$.connectionResourceLimits."${encodeURIComponent(providerId)}"`;
	const [row] = await db
		.select({
			policy: sql<
				string | null
			>`json_extract(${organizations.metadata}, ${path})`,
		})
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!row)
		throw new Error(
			"Organization not found while resolving connection resources",
		);
	return row.policy === null
		? null
		: ConnectionAllowedResourcesSchema.parse(JSON.parse(row.policy));
}

export async function setOrganizationConnectionAllowedResources(
	db: DbQueryClient,
	organizationId: string,
	providerId: string,
	allowedResources: ConnectionAllowedResources | null,
) {
	const validated =
		ConnectionAllowedResourcesSchema.nullable().parse(allowedResources);
	const path = `$.connectionResourceLimits."${encodeURIComponent(providerId)}"`;
	const [row] = await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), ${path}, json(${JSON.stringify(validated)}))`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizations.id, organizationId))
		.returning({ id: organizations.id });
	return row;
}
