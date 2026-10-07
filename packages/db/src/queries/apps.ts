/**
 * App Hostname & App Store Query Helpers
 * Database queries for slug-based app lookup and App Store management
 *
 * Enables multi-tenant MCP routing:
 * - acme.mcp.tedix.dev → getAppBySlug("acme") (slug = subdomain)
 * - mcp.acme.example → getAppByCustomDomain("mcp.acme.example")
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { App } from "../schema/apps";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { organizations } from "../schema/organizations";
import { chunkForBoundParams } from "../utils/batch";

const D1_IN_LIST_CHUNK = 50;

export type AppSyncSource = "openapi" | "google-discovery";

export async function listApiSyncApps(
	db: DbClient,
	options: { source?: AppSyncSource; limit?: number } = {},
): Promise<Array<{ id: string; slug: string }>> {
	const openApiEnabled = sql<boolean>`json_extract(${apps.metadata}, '$.mcpConfig.openApiSync.enabled') = 1`;
	const googleEnabled = sql<boolean>`json_extract(${apps.metadata}, '$.mcpConfig.googleDiscoverySync.enabled') = 1`;
	const enabled =
		options.source === "openapi"
			? openApiEnabled
			: options.source === "google-discovery"
				? googleEnabled
				: or(openApiEnabled, googleEnabled);
	return db
		.select({ id: apps.id, slug: apps.slug })
		.from(apps)
		.where(enabled)
		.limit(Math.min(Math.max(options.limit ?? 50, 1), 50));
}

export async function getAppMetadataById(db: DbClient, id: string) {
	const [row] = await db
		.select({ metadata: apps.metadata })
		.from(apps)
		.where(eq(apps.id, id))
		.limit(1);
	return row?.metadata;
}

export async function getLinkedOpenApiCatalogSnapshot(
	db: DbClient,
	appId: string,
): Promise<{ catalogAppId: string | null; toolSource: string | null } | null> {
	const [row] = await db
		.select({
			catalogAppId: apps.catalogAppId,
			toolSource: appCatalog.toolSource,
		})
		.from(apps)
		.leftJoin(appCatalog, eq(apps.catalogAppId, appCatalog.id))
		.where(eq(apps.id, appId))
		.limit(1);
	return row ?? null;
}

export async function listBaseAppsForCatalogApp(
	db: DbClient,
	catalogAppId: string,
): Promise<Array<{ id: string; name: string; metadata: App["metadata"] }>> {
	return db
		.select({ id: apps.id, name: apps.name, metadata: apps.metadata })
		.from(apps)
		.where(and(eq(apps.catalogAppId, catalogAppId), isNull(apps.sourceAppId)));
}

export async function getCatalogBaseApp(
	db: DbClient,
	input: { catalogAppId: string; baseAppId?: string },
): Promise<App | null> {
	if (input.baseAppId) {
		return (
			(await db.query.apps.findFirst({ where: { id: input.baseAppId } })) ??
			null
		);
	}
	const [row] = await db
		.select()
		.from(apps)
		.where(
			and(eq(apps.catalogAppId, input.catalogAppId), isNull(apps.sourceAppId)),
		)
		.orderBy(asc(apps.createdAt))
		.limit(1);
	return row ?? null;
}

export async function listBaseAppsForCatalogApps(
	db: DbClient,
	catalogAppIds: string[],
): Promise<App[]> {
	const rows: App[] = [];
	for (let index = 0; index < catalogAppIds.length; index += 50) {
		rows.push(
			...(await db
				.select()
				.from(apps)
				.where(
					and(
						inArray(apps.catalogAppId, catalogAppIds.slice(index, index + 50)),
						isNull(apps.sourceAppId),
					),
				)),
		);
	}
	return rows;
}

export async function getCatalogProxyApp(
	db: DbClient,
	input: { organizationId: string; catalogAppId: string; sourceAppId: string },
): Promise<App | null> {
	return (await db.query.apps.findFirst({ where: input })) ?? null;
}

export async function countAutoSyncBaseApps(db: DbClient): Promise<number> {
	return db.$count(
		apps,
		sql`json_extract(${apps.metadata}, '$.mcpConfig.autoSync') = 1`,
	);
}

// ============================================================================
// Slug & Hostname Lookup
// ============================================================================

/**
 * Get app by slug
 * Used for routing requests like acme.mcp.tedix.dev
 * Slugs are globally unique and serve as the subdomain directly.
 *
 * @param db - Database client
 * @param slug - The app slug (e.g., "acme")
 * @returns App or null if not found
 */
export async function getAppBySlug(
	db: DbClient,
	slug: string,
): Promise<App | null> {
	return (
		(await db.query.apps.findFirst({ where: { slug: slug.toLowerCase() } })) ??
		null
	);
}

export type AppReferenceMetadataRow = Pick<
	App,
	"id" | "slug" | "organizationId" | "metadata"
>;

/** Narrow organization-scoped seed projection for app-reference traversal. */
export async function listAppReferenceMetadataByOrganization(
	db: DbClient,
	organizationId: string,
): Promise<AppReferenceMetadataRow[]> {
	return db
		.select({
			id: apps.id,
			slug: apps.slug,
			organizationId: apps.organizationId,
			metadata: apps.metadata,
		})
		.from(apps)
		.where(eq(apps.organizationId, organizationId));
}

/** Narrow bulk projection for recursive app-reference traversal. */
export async function listAppReferenceMetadataBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<AppReferenceMetadataRow[]> {
	const rows: AppReferenceMetadataRow[] = [];
	const normalizedSlugs = [
		...new Set(slugs.map((slug) => slug.trim().toLowerCase()).filter(Boolean)),
	];
	for (const chunk of chunkForBoundParams(normalizedSlugs, D1_IN_LIST_CHUNK)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
				})
				.from(apps)
				.where(inArray(apps.slug, chunk))),
		);
	}
	return rows;
}

/**
 * Narrow bulk projection by app id, for `aggregateApps` entries that link by
 * their stable `appId` instead of a slug.
 */
export async function listAppReferenceMetadataByIds(
	db: DbClient,
	ids: string[],
): Promise<AppReferenceMetadataRow[]> {
	const rows: AppReferenceMetadataRow[] = [];
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	for (const chunk of chunkForBoundParams(uniqueIds, D1_IN_LIST_CHUNK)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
				})
				.from(apps)
				.where(inArray(apps.id, chunk))),
		);
	}
	return rows;
}

export type PreviewSourceAppRow = AppReferenceMetadataRow & {
	sourceOrgSlug: string;
	sourceOrgTenantId: string | null;
};

/** Resolve aggregate preview sources and their ownership in bounded waves. */
export async function listPreviewSourceAppsBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<PreviewSourceAppRow[]> {
	const rows: PreviewSourceAppRow[] = [];
	const normalizedSlugs = [
		...new Set(slugs.map((slug) => slug.trim().toLowerCase()).filter(Boolean)),
	];
	for (const chunk of chunkForBoundParams(normalizedSlugs, D1_IN_LIST_CHUNK)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
					sourceOrgSlug: sql<string>`${organizations.slug}`.as(
						"source_org_slug",
					),
					sourceOrgTenantId: sql<
						string | null
					>`${organizations.descopeTenantId}`.as("source_org_tenant_id"),
				})
				.from(apps)
				.innerJoin(organizations, eq(apps.organizationId, organizations.id))
				.where(inArray(apps.slug, chunk))),
		);
	}
	return rows;
}

/** {@link listPreviewSourceAppsBySlugs} for entries that link by `appId`. */
export async function listPreviewSourceAppsByIds(
	db: DbClient,
	ids: string[],
): Promise<PreviewSourceAppRow[]> {
	const rows: PreviewSourceAppRow[] = [];
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	for (const chunk of chunkForBoundParams(uniqueIds, D1_IN_LIST_CHUNK)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
					sourceOrgSlug: sql<string>`${organizations.slug}`.as(
						"source_org_slug",
					),
					sourceOrgTenantId: sql<
						string | null
					>`${organizations.descopeTenantId}`.as("source_org_tenant_id"),
				})
				.from(apps)
				.innerJoin(organizations, eq(apps.organizationId, organizations.id))
				.where(inArray(apps.id, chunk))),
		);
	}
	return rows;
}

/**
 * Get app by slug scoped to an organization.
 *
 * Slugs are unique per `(organizationId, slug)` — NOT globally (see the
 * `uniq_app_org_slug` constraint) — so the bare {@link getAppBySlug} can resolve
 * a *different* org's app for a shared slug. Use this on any path where the
 * result must belong to a specific tenant, e.g. kernel direct-read provider
 * resolution: a bare lookup could otherwise apply another org's tenant
 * tool-param defaults (workspace ids / credentials) to this org's tool call.
 */
export async function getAppBySlugForOrg(
	db: DbClient,
	slug: string,
	organizationId: string,
): Promise<App | null> {
	return (
		(await db.query.apps.findFirst({
			where: { slug: slug.toLowerCase(), organizationId },
		})) ?? null
	);
}

// ============================================================================
// Organization-Scoped Queries
// ============================================================================

/**
 * Get all apps for an organization
 */
export async function getAppsByOrganization(
	db: DbClient,
	organizationId: string,
): Promise<App[]> {
	return db.select().from(apps).where(eq(apps.organizationId, organizationId));
}

// ============================================================================
// Full App Listing
// ============================================================================

/**
 * Get all apps, optionally filtered by ID.
 * Used by workflows that need to iterate over all apps (e.g., content sync).
 */
export async function getAllApps(
	db: DbClient,
	opts?: { appId?: string },
): Promise<App[]> {
	if (opts?.appId) {
		return db.query.apps.findMany({ where: { id: opts.appId } });
	}
	return db.query.apps.findMany();
}
