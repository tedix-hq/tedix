/**
 * App Gating Query Helpers
 * Drizzle ORM queries for organization state resolution and app eligibility.
 */

import { coreTable } from "../core-store/client";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps as schemaApps } from "../schema/apps";
import { organizations as schemaOrganizations } from "../schema/organizations";
import { appTools as schemaAppTools } from "../schema/tools";
import { anyIds } from "../core-store/dialect";
import { toolDefinitionIsLive } from "./tool-review-visibility";

// =============================================================================
// ORG STATE
// =============================================================================

/**
 * Fetch non-entitlement organization state used by app gating.
 */
export async function getOrgForGating(db: DbClient, orgId: string) {
	const organizations = coreTable(db, schemaOrganizations);
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
	const apps = coreTable(db, schemaApps);
	const appTools = coreTable(db, schemaAppTools);
	const rows = await db
		.select({ toolId: appTools.toolId })
		.from(appTools)
		.innerJoin(apps, eq(appTools.appId, apps.id))
		.where(
			and(
				eq(apps.organizationId, orgId),
				eq(appTools.enabled, true),
				toolDefinitionIsLive(),
			),
		);
	return rows.map((r) => r.toolId);
}

// =============================================================================
// APP ELIGIBILITY
// =============================================================================

/**
 * Fetch gating metadata for a single app.
 */
export async function getAppGatingMetadata(db: DbClient, appId: string) {
	const apps = coreTable(db, schemaApps);
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
	const appTools = coreTable(db, schemaAppTools);
	const rows = await db
		.select({ toolId: appTools.toolId })
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, appId),
				eq(appTools.enabled, true),
				toolDefinitionIsLive(),
			),
		);
	return rows.map((r) => r.toolId);
}

/**
 * Fetch all apps for an org with gating metadata.
 */
export async function getOrgAppsWithGating(db: DbClient, orgId: string) {
	const apps = coreTable(db, schemaApps);
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
	const apps = coreTable(db, schemaApps);
	if (appIds.length === 0) return [];
	return db
		.select({ id: apps.id, gatingMetadata: apps.gatingMetadata })
		.from(apps)
		.where(
			and(
				anyIds(db, apps.id, [...new Set(appIds)]),
				eq(apps.organizationId, orgId),
			),
		);
}

/**
 * Fetch enabled tools with full details for an app (runtime tools).
 */
export async function getEnabledToolDetailsForApp(db: DbClient, appId: string) {
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			toolId: appTools.toolId,
			title: appTools.title,
			description: appTools.description,
			inputSchema: appTools.inputSchema,
		})
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, appId),
				eq(appTools.enabled, true),
				toolDefinitionIsLive(),
			),
		);
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
	const appTools = coreTable(db, schemaAppTools);
	return db
		.select({
			toolId: appTools.toolId,
			title: appTools.title,
			description: appTools.description,
			inputSchema: appTools.inputSchema,
			writeCapability: appTools.writeCapability,
		})
		.from(appTools)
		.where(
			and(
				eq(appTools.appId, appId),
				eq(appTools.enabled, true),
				toolDefinitionIsLive(),
			),
		);
}
