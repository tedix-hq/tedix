import {
	ConnectionAllowedResourcesSchema,
	type ConnectionAllowedResources,
} from "@tedix/api-contract/schemas/connections";
import { organizations } from "../schema/organizations";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { connectionInstances } from "../schema/connection-instances";
import type { ConnectionInstanceRow } from "../schema/connection-instances";
import { coreTable } from "../core-store/client";
import { coreStore, jsonRead, jsonWrite } from "../core-store/dialect";

/** Missing, foreign and mismatched pairs are omitted; callers must deny missing slots. */
export async function listOrganizationConnectionInstances(
	db: DbQueryClient,
	organizationId: string,
	pairs: readonly { providerId: string; id: string }[],
): Promise<
	Array<Pick<ConnectionInstanceRow, "id" | "providerId" | "allowedResources">>
> {
	if (!pairs.length) return [];
	const table = coreTable(db, connectionInstances);
	const set = JSON.stringify(
		pairs.map(({ providerId, id }) => ({ providerId, id })),
	);
	const matches =
		coreStore(db) === "postgres"
			? sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${set}::text::jsonb) AS pair(value) WHERE pair.value->>'id' = ${table.id} AND pair.value->>'providerId' = ${table.providerId})`
			: sql`EXISTS (SELECT 1 FROM json_each(${set}) AS pair WHERE json_extract(pair.value, '$.id') = ${table.id} AND json_extract(pair.value, '$.providerId') = ${table.providerId})`;
	return db
		.select({
			id: table.id,
			providerId: table.providerId,
			allowedResources: table.allowedResources,
		})
		.from(table)
		.where(and(eq(table.organizationId, organizationId), matches));
}

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

/**
 * The accounts of these providers that hold a grant: the organization's and,
 * when a person is named, that person's own. Returns no owner and no grant id.
 */
export async function listConnectedAccounts(
	db: DbQueryClient,
	params: { organizationId: string; userId?: string; providerIds: string[] },
) {
	const providerIds = [...new Set(params.providerIds)];
	const accounts: Array<{
		id: string;
		providerId: string;
		scope: "tenant" | "user";
	}> = [];
	// D1 binds at most 100 values a statement.
	for (let start = 0; start < providerIds.length; start += 50) {
		const rows = await db
			.select({
				id: connectionInstances.id,
				providerId: connectionInstances.providerId,
				organizationId: connectionInstances.organizationId,
				tokenIds: connectionInstances.tokenIds,
				tokenSub: connectionInstances.tokenSub,
			})
			.from(connectionInstances)
			.where(
				and(
					inArray(
						connectionInstances.providerId,
						providerIds.slice(start, start + 50),
					),
					or(
						eq(connectionInstances.organizationId, params.organizationId),
						params.userId
							? and(
									eq(connectionInstances.ownerUserId, params.userId),
									isNull(connectionInstances.organizationId),
								)
							: undefined,
					),
				),
			);
		for (const row of rows)
			if (row.tokenIds.length > 0 && row.tokenSub)
				accounts.push({
					id: row.id,
					providerId: row.providerId,
					scope: row.organizationId ? "tenant" : "user",
				});
	}
	return accounts;
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
			tokenIds:
				coreStore(db) === "postgres"
					? sql`CASE WHEN ${connectionInstances.tokenIds} @> jsonb_build_array(${params.tokenId}::text) THEN ${connectionInstances.tokenIds} ELSE ${connectionInstances.tokenIds} || jsonb_build_array(${params.tokenId}::text) END`
					: sql`CASE WHEN EXISTS (SELECT 1 FROM json_each(${connectionInstances.tokenIds}) WHERE value = ${params.tokenId}) THEN ${connectionInstances.tokenIds} ELSE json_insert(${connectionInstances.tokenIds}, '$[#]', ${params.tokenId}) END`,
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
			policy: sql<string | null>`${
				coreStore(db) === "postgres"
					? jsonRead(db, organizations.metadata, [
							"connectionResourceLimits",
							encodeURIComponent(providerId),
						])
					: sql`json_extract(${organizations.metadata}, ${path})`
			}`,
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
			metadata:
				coreStore(db) === "postgres"
					? jsonWrite(
							db,
							organizations.metadata,
							["connectionResourceLimits", encodeURIComponent(providerId)],
							validated,
						)
					: sql`json_set(coalesce(${organizations.metadata}, '{}'), ${path}, json(${JSON.stringify(validated)}))`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(organizations.id, organizationId))
		.returning({ id: organizations.id });
	return row;
}
