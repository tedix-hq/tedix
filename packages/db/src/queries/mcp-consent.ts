import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import {
	mcpConsentGrants,
	mcpConsentSelections,
	mcpConsentPending,
	type McpConsentGrantRow,
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
	const key = sql`descope_user_id = ${input.descopeUserId} AND mcp_server_id = ${input.mcpServerId} AND client_id = ${input.clientId}`;
	// A latest decision written before grants existed becomes an explicit grant
	// before the selection row moves on.
	const preserve = db.run(sql`
 INSERT OR IGNORE INTO mcp_consent_grants
 (descope_user_id, mcp_server_id, client_id, revision, app_id, selected_tenant_ids, approved_scopes, created_at)
 SELECT descope_user_id, mcp_server_id, client_id, revision, app_id, selected_tenant_ids, approved_scopes, updated_at
 FROM mcp_consent_selections WHERE ${key} AND status = 'active'
 `);
	const fence = (selection: SQL) => sql`(
  ${selection}.revision = ${input.expectedActiveRevision}
  OR (${selection}.status = 'active' AND EXISTS (
   SELECT 1 FROM mcp_consent_grants g WHERE g.descope_user_id = ${selection}.descope_user_id
   AND g.mcp_server_id = ${selection}.mcp_server_id AND g.client_id = ${selection}.client_id
   AND g.revision = ${input.expectedActiveRevision}
  ))
 )`;
	const promote = db.all<{ revision: string }>(sql`
 INSERT INTO mcp_consent_selections
 (descope_user_id, mcp_server_id, client_id, app_id, revision, status, selected_tenant_ids, approved_scopes, created_at, updated_at)
 SELECT p.descope_user_id, p.mcp_server_id, p.client_id, p.app_id, p.revision, 'active', p.selected_tenant_ids, p.approved_scopes, ${now}, ${now}
 FROM mcp_consent_pending p
 WHERE p.descope_user_id = ${input.descopeUserId} AND p.mcp_server_id = ${input.mcpServerId}
 AND p.client_id = ${input.clientId} AND p.app_id = ${input.appId} AND p.revision = ${input.revision}
 AND p.expected_active_revision IS ${input.expectedActiveRevision} AND p.expires_at > ${now}
 AND p.selected_tenant_ids = ${JSON.stringify([...input.selectedTenantIds].sort())}
 AND p.approved_scopes = ${JSON.stringify([...input.approvedScopes].sort())}
 AND (
  (${input.expectedActiveRevision} IS NULL AND NOT EXISTS (
   SELECT 1 FROM mcp_consent_selections a WHERE a.descope_user_id = p.descope_user_id
   AND a.mcp_server_id = p.mcp_server_id AND a.client_id = p.client_id
  )) OR EXISTS (
   SELECT 1 FROM mcp_consent_selections a WHERE a.descope_user_id = p.descope_user_id
   AND a.mcp_server_id = p.mcp_server_id AND a.client_id = p.client_id AND ${fence(sql`a`)}
  )
 )
 ON CONFLICT(descope_user_id, mcp_server_id, client_id) DO UPDATE SET
 app_id = excluded.app_id, revision = excluded.revision, status = excluded.status,
 selected_tenant_ids = excluded.selected_tenant_ids, approved_scopes = excluded.approved_scopes, updated_at = excluded.updated_at
 WHERE ${fence(sql`mcp_consent_selections`)}
 RETURNING revision
 `);
	// Only a selection this batch just activated yields a grant.
	const grant = db.run(sql`
 INSERT OR IGNORE INTO mcp_consent_grants
 (descope_user_id, mcp_server_id, client_id, revision, app_id, selected_tenant_ids, approved_scopes, created_at)
 SELECT descope_user_id, mcp_server_id, client_id, revision, app_id, selected_tenant_ids, approved_scopes, ${now}
 FROM mcp_consent_selections WHERE ${key} AND revision = ${input.revision}
 AND status = 'active' AND updated_at = ${now}
 `);
	const prune = db.run(sql`
 DELETE FROM mcp_consent_grants WHERE ${key} AND revision NOT IN (
  SELECT revision FROM mcp_consent_grants WHERE ${key}
  ORDER BY created_at DESC, revision DESC LIMIT ${MAX_MCP_CONSENT_GRANTS_PER_CLIENT}
 )
 `);
	const [, rows] = await db.batch([preserve, promote, grant, prune]);
	return rows.length === 1;
}
