/**
 * App Gating Query Helpers
 * Drizzle ORM queries for organization state resolution and app eligibility.
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import { appTools } from "../schema/tools";
import { chunkForBoundParams } from "../utils/batch";

// =============================================================================
// ORG STATE
// =============================================================================

/**
 * Fetch non-entitlement organization state used by app gating.
 */
export async function getOrgForGating(db: DbClient, orgId: string) {
	return db
		.select({
			descopeTenantId: organizations.descopeTenantId,
			features: organizations.features,
		})
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1)
		.then((rows) => rows[0] ?? null);
}

/**
 * Fetch enabled tool IDs for an org's installed apps.
 */
export async function getInstalledToolIdsForOrg(db: DbClient, orgId: string) {
	const rows = await db
		.select({ toolId: appTools.toolId })
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(and(eq(apps.organizationId, orgId), eq(appTools.enabled, true)));
	return rows.map((r) => r.toolId);
}

// =============================================================================
// APP ELIGIBILITY
// =============================================================================

/**
 * Fetch gating metadata for a single app.
 */
export async function getAppGatingMetadata(db: DbClient, appId: string) {
	return db
		.select({ gatingMetadata: apps.gatingMetadata })
		.from(apps)
		.where(eq(apps.id, appId))
		.limit(1)
		.then((rows) => rows[0] ?? null);
}

/**
 * Fetch enabled tool IDs for an app.
 */
export async function getEnabledToolIdsForApp(db: DbClient, appId: string) {
	const rows = await db
		.select({ toolId: appTools.toolId })
		.from(appTools)
		.where(and(eq(appTools.appId, appId), eq(appTools.enabled, true)));
	return rows.map((r) => r.toolId);
}

/**
 * Fetch all apps for an org with gating metadata.
 */
export async function getOrgAppsWithGating(db: DbClient, orgId: string) {
	return db
		.select({
			id: apps.id,
			name: apps.name,
			gatingMetadata: apps.gatingMetadata,
		})
		.from(apps)
		.where(eq(apps.organizationId, orgId));
}

/**
 * Fetch apps by IDs with gating metadata.
 * App IDs come from FGA (Descope AuthZ) — caller resolves which apps the tedi operates.
 */
export async function getAppsWithGatingByIds(
	db: DbClient,
	appIds: string[],
	orgId: string,
) {
	if (appIds.length === 0) return [];
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				id: apps.id,
				gatingMetadata: apps.gatingMetadata,
			})
			.from(apps)
			.where(and(inArray(apps.id, chunk), eq(apps.organizationId, orgId)));
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(appIds)], 50)) {
		rows.push(...(await selectChunk(chunk)));
	}
	return rows;
}

/**
 * Fetch enabled tools with full details for an app (runtime tools).
 */
export async function getEnabledToolDetailsForApp(db: DbClient, appId: string) {
	return db
		.select({
			toolId: appTools.toolId,
			title: appTools.title,
			description: appTools.description,
			inputSchema: appTools.inputSchema,
		})
		.from(appTools)
		.where(and(eq(appTools.appId, appId), eq(appTools.enabled, true)));
}

/**
 * Fetch the authoritative fields used to admit provider-managed Portable
 * WebMCP tools. `writeCapability` is deliberately included instead of
 * inferring safety from a provider-authored profile or a tool name.
 */
export async function getPortableWebMcpToolAdmissions(
	db: DbClient,
	appId: string,
) {
	return db
		.select({
			toolId: appTools.toolId,
			title: appTools.title,
			description: appTools.description,
			inputSchema: appTools.inputSchema,
			writeCapability: appTools.writeCapability,
		})
		.from(appTools)
		.where(and(eq(appTools.appId, appId), eq(appTools.enabled, true)));
}
