import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import {
	mcpConsentSelections,
	mcpConsentPending,
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

/**
 * One D1 statement swaps the current revision and authority set. The API
 * generates a fresh revision before every replacement or revocation.
 */
export async function replaceMcpConsentSelection(
	db: DbQueryClient,
	input: ReplaceMcpConsentSelectionParams,
): Promise<McpConsentSelectionRow> {
	const now = new Date().toISOString();
	const [row] = await db
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
	if (!row) throw new Error("Failed to replace MCP consent selection");
	return row;
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

/** Disable only an existing owned revision, even when its OAuth client was removed. */
export async function disableMcpConsentSelection(
	db: DbQueryClient,
	input: McpConsentSelectionKey & {
		expectedRevision: string;
		revision: string;
	},
) {
	const [row] = await db
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

/** One conditional statement checks the immutable candidate and predecessor fence. */
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
	const rows = await db.all<{ revision: string }>(sql`
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
   AND a.mcp_server_id = p.mcp_server_id AND a.client_id = p.client_id AND a.revision = ${input.expectedActiveRevision}
  )
 )
 ON CONFLICT(descope_user_id, mcp_server_id, client_id) DO UPDATE SET
 app_id = excluded.app_id, revision = excluded.revision, status = excluded.status,
 selected_tenant_ids = excluded.selected_tenant_ids, approved_scopes = excluded.approved_scopes, updated_at = excluded.updated_at
 WHERE mcp_consent_selections.revision = ${input.expectedActiveRevision}
 RETURNING revision
 `);
	return rows.length === 1;
}
