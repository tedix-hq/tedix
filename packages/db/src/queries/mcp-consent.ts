import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	notExists,
	notInArray,
	or,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import {
	mcpConsentGrants,
	mcpConsentSelections,
	mcpConsentPending,
	mcpInboundClientAttempts,
	type McpConsentGrantRow,
	type McpInboundClientAttemptRow,
	type NewMcpConsentPendingRow,
	type McpConsentSelectionRow,
} from "../schema/mcp-consent";

export interface McpConsentSelectionKey {
	descopeUserId: string;
	mcpServerId: string;
	clientId: string;
}

export interface ReplaceMcpConsentSelectionParams extends McpConsentSelectionKey {
	appId: string;
	revision: string;
	status: McpConsentSelectionRow["status"];
	selectedTenantIds: string[];
	approvedScopes: string[];
}

/** Active grants kept per user, server and client; older revisions are pruned. */
export const MAX_MCP_CONSENT_GRANTS_PER_CLIENT = 20;

function grantKeyCondition(key: McpConsentSelectionKey) {
	return and(
		eq(mcpConsentGrants.descopeUserId, key.descopeUserId),
		eq(mcpConsentGrants.mcpServerId, key.mcpServerId),
		eq(mcpConsentGrants.clientId, key.clientId),
	);
}

/**
 * One D1 batch swaps the latest revision and replaces every grant for the key:
 * a revocation removes all of them, an active replacement leaves only itself.
 * The API generates a fresh revision before every replacement or revocation.
 */
export async function replaceMcpConsentSelection(
	db: DbQueryClient,
	input: ReplaceMcpConsentSelectionParams,
): Promise<McpConsentSelectionRow> {
	const now = new Date().toISOString();
	const upsert = db
		.insert(mcpConsentSelections)
		.values({ ...input, updatedAt: now })
		.onConflictDoUpdate({
			target: [
				mcpConsentSelections.descopeUserId,
				mcpConsentSelections.mcpServerId,
				mcpConsentSelections.clientId,
			],
			set: {
				appId: input.appId,
				revision: input.revision,
				status: input.status,
				selectedTenantIds: input.selectedTenantIds,
				approvedScopes: input.approvedScopes,
				updatedAt: now,
			},
		})
		.returning();
	const clear = db.delete(mcpConsentGrants).where(grantKeyCondition(input));
	const [[row]] =
		input.status === "active"
			? await db.batch([
					upsert,
					clear,
					db.insert(mcpConsentGrants).values({
						descopeUserId: input.descopeUserId,
						mcpServerId: input.mcpServerId,
						clientId: input.clientId,
						revision: input.revision,
						appId: input.appId,
						selectedTenantIds: input.selectedTenantIds,
						approvedScopes: input.approvedScopes,
						createdAt: now,
					}),
				])
			: await db.batch([upsert, clear]);
	if (!row) throw new Error("Failed to replace MCP consent selection");
	return row;
}

export interface McpConsentGrantResult {
	appId: string;
	revision: string;
	selectedTenantIds: string[];
	approvedScopes: string[];
}

/**
 * The active grant for one signed revision. A selection row that is still
 * active but has no grant row (written before grants existed) counts as that
 * revision's grant; revocation removes both.
 */
export async function getMcpConsentGrant(
	db: DbQueryClient,
	key: McpConsentSelectionKey & { revision: string },
): Promise<McpConsentGrantResult | null> {
	const [grant] = await db
		.select({
			appId: mcpConsentGrants.appId,
			revision: mcpConsentGrants.revision,
			selectedTenantIds: mcpConsentGrants.selectedTenantIds,
			approvedScopes: mcpConsentGrants.approvedScopes,
		})
		.from(mcpConsentGrants)
		.where(
			and(grantKeyCondition(key), eq(mcpConsentGrants.revision, key.revision)),
		)
		.limit(1);
	if (grant) return grant;
	const [legacy] = await db
		.select({
			appId: mcpConsentSelections.appId,
			revision: mcpConsentSelections.revision,
			selectedTenantIds: mcpConsentSelections.selectedTenantIds,
			approvedScopes: mcpConsentSelections.approvedScopes,
		})
		.from(mcpConsentSelections)
		.where(
			and(
				eq(mcpConsentSelections.descopeUserId, key.descopeUserId),
				eq(mcpConsentSelections.mcpServerId, key.mcpServerId),
				eq(mcpConsentSelections.clientId, key.clientId),
				eq(mcpConsentSelections.revision, key.revision),
				eq(mcpConsentSelections.status, "active"),
			),
		)
		.limit(1);
	return legacy ?? null;
}

/** Active grants for one key, newest first. */
export async function listMcpConsentGrants(
	db: DbQueryClient,
	key: McpConsentSelectionKey,
): Promise<McpConsentGrantRow[]> {
	return db
		.select()
		.from(mcpConsentGrants)
		.where(grantKeyCondition(key))
		.orderBy(desc(mcpConsentGrants.createdAt), desc(mcpConsentGrants.revision));
}

export async function getMcpConsentSelection(
	db: DbQueryClient,
	key: McpConsentSelectionKey,
): Promise<McpConsentSelectionRow | null> {
	const [row] = await db
		.select()
		.from(mcpConsentSelections)
		.where(
			and(
				eq(mcpConsentSelections.descopeUserId, key.descopeUserId),
				eq(mcpConsentSelections.mcpServerId, key.mcpServerId),
				eq(mcpConsentSelections.clientId, key.clientId),
			),
		)
		.limit(1);
	return row ?? null;
}

/** Subject ownership and resource boundaries are applied before pagination. */
export async function listMcpConsentSelections(
	db: DbQueryClient,
	input: {
		descopeUserId: string;
		mcpServerId?: string;
		limit: number;
		offset: number;
	},
) {
	return db
		.select()
		.from(mcpConsentSelections)
		.where(
			and(
				eq(mcpConsentSelections.descopeUserId, input.descopeUserId),
				input.mcpServerId
					? eq(mcpConsentSelections.mcpServerId, input.mcpServerId)
					: undefined,
			),
		)
		.orderBy(asc(mcpConsentSelections.clientId))
		.limit(input.limit)
		.offset(input.offset);
}

/**
 * Disable only an existing owned revision, even when its OAuth client was
 * removed. The same batch removes every grant for the key once the fence moved.
 */
export async function disableMcpConsentSelection(
	db: DbQueryClient,
	input: McpConsentSelectionKey & {
		expectedRevision: string;
		revision: string;
	},
) {
	const disable = db
		.update(mcpConsentSelections)
		.set({
			status: "revoked",
			revision: input.revision,
			selectedTenantIds: [],
			approvedScopes: [],
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(mcpConsentSelections.descopeUserId, input.descopeUserId),
				eq(mcpConsentSelections.mcpServerId, input.mcpServerId),
				eq(mcpConsentSelections.clientId, input.clientId),
				eq(mcpConsentSelections.revision, input.expectedRevision),
			),
		)
		.returning();
	const clear = db
		.delete(mcpConsentGrants)
		.where(
			and(
				grantKeyCondition(input),
				sql`EXISTS (SELECT 1 FROM ${mcpConsentSelections} WHERE ${mcpConsentSelections.descopeUserId} = ${input.descopeUserId} AND ${mcpConsentSelections.mcpServerId} = ${input.mcpServerId} AND ${mcpConsentSelections.clientId} = ${input.clientId} AND ${mcpConsentSelections.revision} = ${input.revision} AND ${mcpConsentSelections.status} = 'revoked')`,
			),
		);
	const [[row]] = await db.batch([disable, clear]);
	return row ?? null;
}

/** Resolve one configured MCP resource and its owning organization. Ambiguity denies access. */
export async function getMcpConsentResource(
	db: DbQueryClient,
	resource: { mcpServerId: string } | { resourceUrl: string },
) {
	const rows = await db
		.select({
			appId: apps.id,
			slug: apps.slug,
			organizationId: apps.organizationId,
			metadata: apps.metadata,
			descopeTenantId: organizations.descopeTenantId,
		})
		.from(apps)
		.innerJoin(organizations, eq(apps.organizationId, organizations.id))
		.where(
			"mcpServerId" in resource
				? sql`json_extract(${apps.metadata}, '$.mcpConfig.descopeResourceId') = ${resource.mcpServerId}`
				: sql`COALESCE(NULLIF(json_extract(${apps.metadata}, '$.mcpConfig.expectedAudience'), ''), 'https://' || COALESCE(${apps.customMcpDomain}, ${apps.slug} || '.mcp.tedix.dev') || '/mcp') = ${resource.resourceUrl}`,
		)
		.limit(2);
	return rows.length === 1 ? rows[0]! : null;
}

export async function stageMcpConsentPending(
	db: DbQueryClient,
	input: NewMcpConsentPendingRow,
) {
	const [row] = await db.insert(mcpConsentPending).values(input).returning();
	if (!row) throw new Error("Failed to stage MCP consent candidate");
	return row;
}

export async function getMcpConsentPending(
	db: DbQueryClient,
	key: McpConsentSelectionKey & { revision: string },
) {
	const [row] = await db
		.select()
		.from(mcpConsentPending)
		.where(
			and(
				eq(mcpConsentPending.descopeUserId, key.descopeUserId),
				eq(mcpConsentPending.mcpServerId, key.mcpServerId),
				eq(mcpConsentPending.clientId, key.clientId),
				eq(mcpConsentPending.revision, key.revision),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * One D1 batch adds the immutable candidate as another active grant. The
 * predecessor fence passes while the revision seen at staging is still the
 * latest decision or still an active grant, so concurrent installs of one
 * client can each activate; a revocation since staging removed every grant and
 * moved the fence, so a stale candidate cannot resurrect access. The oldest
 * grants beyond MAX_MCP_CONSENT_GRANTS_PER_CLIENT are pruned.
 */
export async function promoteMcpConsentPending(
	db: DbQueryClient,
	input: McpConsentSelectionKey & {
		appId: string;
		revision: string;
		expectedActiveRevision: string | null;
		approvedScopes: string[];
		selectedTenantIds: string[];
	},
) {
	const now = new Date().toISOString();
	const selections = mcpConsentSelections;
	const grants = mcpConsentGrants;
	const selectionKey = and(
		eq(selections.descopeUserId, input.descopeUserId),
		eq(selections.mcpServerId, input.mcpServerId),
		eq(selections.clientId, input.clientId),
	);
	const grantKey = and(
		eq(grants.descopeUserId, input.descopeUserId),
		eq(grants.mcpServerId, input.mcpServerId),
		eq(grants.clientId, input.clientId),
	);
	// A latest decision written before grants existed becomes an explicit grant
	// before the selection row moves on.
	const preserve = db
		.insert(grants)
		.select(
			db
				.select({
					descopeUserId: selections.descopeUserId,
					mcpServerId: selections.mcpServerId,
					clientId: selections.clientId,
					revision: selections.revision,
					appId: selections.appId,
					selectedTenantIds: selections.selectedTenantIds,
					approvedScopes: selections.approvedScopes,
					createdAt: selections.updatedAt,
				})
				.from(selections)
				.where(and(selectionKey, eq(selections.status, "active"))),
		)
		.onConflictDoNothing();
	const g = alias(grants, "g");
	const fence = (selection: {
		revision: SQLWrapper;
		status: SQLWrapper;
		descopeUserId: SQLWrapper;
		mcpServerId: SQLWrapper;
		clientId: SQLWrapper;
	}) =>
		or(
			sql`${selection.revision} = ${input.expectedActiveRevision}`,
			and(
				sql`${selection.status} = 'active'`,
				exists(
					db
						.select({ one: sql`1` })
						.from(g)
						.where(
							and(
								sql`${g.descopeUserId} = ${selection.descopeUserId}`,
								sql`${g.mcpServerId} = ${selection.mcpServerId}`,
								sql`${g.clientId} = ${selection.clientId}`,
								sql`${g.revision} = ${input.expectedActiveRevision}`,
							),
						),
				),
			),
		);
	const p = alias(mcpConsentPending, "p");
	const a = alias(selections, "a");
	const sameClient = and(
		eq(a.descopeUserId, p.descopeUserId),
		eq(a.mcpServerId, p.mcpServerId),
		eq(a.clientId, p.clientId),
	);
	const promote = db
		.insert(selections)
		.select(
			db
				.select({
					descopeUserId: p.descopeUserId,
					mcpServerId: p.mcpServerId,
					clientId: p.clientId,
					appId: p.appId,
					revision: p.revision,
					status: sql<"active">`'active'`.as("status"),
					selectedTenantIds: p.selectedTenantIds,
					approvedScopes: p.approvedScopes,
					createdAt: sql<string>`${now}`.as("created_at"),
					updatedAt: sql<string>`${now}`.as("updated_at"),
				})
				.from(p)
				.where(
					and(
						eq(p.descopeUserId, input.descopeUserId),
						eq(p.mcpServerId, input.mcpServerId),
						eq(p.clientId, input.clientId),
						eq(p.appId, input.appId),
						eq(p.revision, input.revision),
						sql`${p.expectedActiveRevision} IS ${input.expectedActiveRevision}`,
						gt(p.expiresAt, now),
						sql`${p.selectedTenantIds} = ${JSON.stringify([...input.selectedTenantIds].sort())}`,
						sql`${p.approvedScopes} = ${JSON.stringify([...input.approvedScopes].sort())}`,
						or(
							and(
								sql`${input.expectedActiveRevision} IS NULL`,
								notExists(
									db
										.select({ one: sql`1` })
										.from(a)
										.where(sameClient),
								),
							),
							exists(
								db
									.select({ one: sql`1` })
									.from(a)
									.where(and(sameClient, fence(a))),
							),
						),
					),
				),
		)
		.onConflictDoUpdate({
			target: [
				selections.descopeUserId,
				selections.mcpServerId,
				selections.clientId,
			],
			set: {
				appId: sql`excluded.app_id`,
				revision: sql`excluded.revision`,
				status: sql`excluded.status`,
				selectedTenantIds: sql`excluded.selected_tenant_ids`,
				approvedScopes: sql`excluded.approved_scopes`,
				updatedAt: sql`excluded.updated_at`,
			},
			setWhere: fence(selections),
		})
		.returning({ revision: selections.revision });
	// Only a selection this batch just activated yields a grant.
	const grant = db
		.insert(grants)
		.select(
			db
				.select({
					descopeUserId: selections.descopeUserId,
					mcpServerId: selections.mcpServerId,
					clientId: selections.clientId,
					revision: selections.revision,
					appId: selections.appId,
					selectedTenantIds: selections.selectedTenantIds,
					approvedScopes: selections.approvedScopes,
					createdAt: sql<string>`${now}`.as("created_at"),
				})
				.from(selections)
				.where(
					and(
						selectionKey,
						eq(selections.revision, input.revision),
						eq(selections.status, "active"),
						eq(selections.updatedAt, now),
					),
				),
		)
		.onConflictDoNothing();
	const prune = db
		.delete(grants)
		.where(
			and(
				grantKey,
				notInArray(
					grants.revision,
					db
						.select({ revision: grants.revision })
						.from(grants)
						.where(grantKey)
						.orderBy(desc(grants.createdAt), desc(grants.revision))
						.limit(MAX_MCP_CONSENT_GRANTS_PER_CLIENT),
				),
			),
		);
	const [, rows] = await db.batch([preserve, promote, grant, prune]);
	return rows.length === 1;
}

/** Rows an admin inventory returns at most, newest first. */
export const MAX_MCP_INBOUND_CLIENT_INVENTORY = 200;

export interface RecordMcpInboundClientAttemptParams {
	organizationId: string;
	mcpServerId: string;
	clientId: string;
	clientName: string | null;
	stage: McpInboundClientAttemptRow["lastStage"];
	mode: McpInboundClientAttemptRow["lastMode"];
	listed: boolean;
	allowed: boolean;
	at: string;
	/** A repeat inside this window only refreshes nothing: retries cost no row writes. */
	minIntervalSeconds: number;
}

/**
 * Upsert the latest decision for one organization, server and client. A repeat
 * of the same decision inside the interval writes no row; a changed decision
 * always does. A recorded client name survives a later grant check that has none.
 */
export async function recordMcpInboundClientAttempt(
	db: DbQueryClient,
	input: RecordMcpInboundClientAttemptParams,
) {
	const denied = input.allowed ? 0 : 1;
	const since = new Date(
		Date.parse(input.at) - input.minIntervalSeconds * 1000,
	).toISOString();
	await db
		.insert(mcpInboundClientAttempts)
		.values({
			organizationId: input.organizationId,
			mcpServerId: input.mcpServerId,
			clientId: input.clientId,
			clientName: input.clientName,
			lastStage: input.stage,
			lastMode: input.mode,
			lastListed: input.listed,
			lastAllowed: input.allowed,
			attemptCount: 1,
			deniedCount: denied,
			firstSeenAt: input.at,
			lastSeenAt: input.at,
		})
		.onConflictDoUpdate({
			target: [
				mcpInboundClientAttempts.organizationId,
				mcpInboundClientAttempts.mcpServerId,
				mcpInboundClientAttempts.clientId,
			],
			set: {
				clientName: sql`COALESCE(excluded.client_name, ${mcpInboundClientAttempts.clientName})`,
				lastStage: input.stage,
				lastMode: input.mode,
				lastListed: input.listed,
				lastAllowed: input.allowed,
				attemptCount: sql`${mcpInboundClientAttempts.attemptCount} + 1`,
				deniedCount: sql`${mcpInboundClientAttempts.deniedCount} + ${denied}`,
				lastSeenAt: input.at,
			},
			setWhere: sql`${mcpInboundClientAttempts.lastSeenAt} < ${since} OR ${mcpInboundClientAttempts.lastStage} <> ${input.stage} OR ${mcpInboundClientAttempts.lastMode} <> ${input.mode} OR ${mcpInboundClientAttempts.lastListed} <> ${input.listed ? 1 : 0} OR ${mcpInboundClientAttempts.lastAllowed} <> ${input.allowed ? 1 : 0}`,
		});
}

/** One organization's recorded decisions, newest first. */
export async function listMcpInboundClientAttempts(
	db: DbQueryClient,
	organizationId: string,
): Promise<McpInboundClientAttemptRow[]> {
	return db
		.select()
		.from(mcpInboundClientAttempts)
		.where(eq(mcpInboundClientAttempts.organizationId, organizationId))
		.orderBy(desc(mcpInboundClientAttempts.lastSeenAt))
		.limit(MAX_MCP_INBOUND_CLIENT_INVENTORY);
}

/**
 * Active Connect grants that select one organization's Descope tenant,
 * grouped per server and client: how many people hold one and the newest.
 */
export async function listMcpConsentGrantClientsForTenant(
	db: DbQueryClient,
	descopeTenantId: string,
) {
	return db
		.select({
			mcpServerId: mcpConsentGrants.mcpServerId,
			clientId: mcpConsentGrants.clientId,
			people: sql<number>`COUNT(DISTINCT ${mcpConsentGrants.descopeUserId})`,
			lastGrantedAt: sql<string>`MAX(${mcpConsentGrants.createdAt})`,
		})
		.from(mcpConsentGrants)
		.where(
			sql`EXISTS (SELECT 1 FROM json_each(${mcpConsentGrants.selectedTenantIds}) WHERE json_each.value = ${descopeTenantId})`,
		)
		.groupBy(mcpConsentGrants.mcpServerId, mcpConsentGrants.clientId)
		.orderBy(desc(sql`MAX(${mcpConsentGrants.createdAt})`))
		.limit(MAX_MCP_INBOUND_CLIENT_INVENTORY);
}
