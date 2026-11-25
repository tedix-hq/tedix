/**
 * App Hostname & App Store Query Helpers
 * Database queries for slug-based app lookup and App Store management
 *
 * Enables multi-tenant MCP routing:
 * - acme.mcp.tedix.dev → getAppBySlug("acme") (slug = subdomain)
 * - mcp.acme.example → getAppByCustomDomain("mcp.acme.example")
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { App } from "../schema/apps";
import { apps as schemaApps } from "../schema/apps";
import { appCatalog as schemaAppCatalog } from "../schema/catalog";
import { organizations as schemaOrganizations } from "../schema/organizations";
import { coreTable } from "../core-store/client";
import { anyIds, coreStore, jsonRead } from "../core-store/dialect";

function syncEnabled(
	db: DbClient,
	metadata: typeof schemaApps.metadata,
	path: string[],
) {
	return coreStore(db) === "postgres"
		? sql`${jsonRead(db, metadata, path, "json")} IN ('true'::jsonb, '1'::jsonb)`
		: sql`${jsonRead(db, metadata, path)} = 1`;
}

export type AppSyncSource = "openapi" | "google-discovery";

export async function listApiSyncApps(
	db: DbClient,
	options: { source?: AppSyncSource; limit?: number } = {},
): Promise<Array<{ id: string; slug: string }>> {
	const apps = coreTable(db, schemaApps);
	const openApiEnabled = syncEnabled(db, apps.metadata, [
		"mcpConfig",
		"openApiSync",
		"enabled",
	]);
	const googleEnabled = syncEnabled(db, apps.metadata, [
		"mcpConfig",
		"googleDiscoverySync",
		"enabled",
	]);
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
	const apps = coreTable(db, schemaApps);
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
	const apps = coreTable(db, schemaApps);
	const appCatalog = coreTable(db, schemaAppCatalog);
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
): Promise<
	Array<{
		id: string;
		organizationId: string;
		name: string;
		metadata: App["metadata"];
	}>
> {
	const apps = coreTable(db, schemaApps);
	return db
		.select({
			id: apps.id,
			organizationId: apps.organizationId,
			name: apps.name,
			metadata: apps.metadata,
		})
		.from(apps)
		.where(and(eq(apps.catalogAppId, catalogAppId), isNull(apps.sourceAppId)));
}

export async function getCatalogBaseApp(
	db: DbClient,
	input: { catalogAppId: string; baseAppId?: string },
): Promise<App | null> {
	const apps = coreTable(db, schemaApps);
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
		.orderBy(sql`${apps.createdAt} ASC NULLS FIRST`)
		.limit(1);
	return row ?? null;
}

export async function listBaseAppsForCatalogApps(
	db: DbClient,
	catalogAppIds: string[],
): Promise<App[]> {
	const apps = coreTable(db, schemaApps);
	if (!catalogAppIds.length) return [];
	return db
		.select()
		.from(apps)
		.where(
			and(
				anyIds(db, apps.catalogAppId, catalogAppIds),
				isNull(apps.sourceAppId),
			),
		);
}

export async function getCatalogProxyApp(
	db: DbClient,
	input: { organizationId: string; catalogAppId: string; sourceAppId: string },
): Promise<App | null> {
	return (await db.query.apps.findFirst({ where: input })) ?? null;
}

export async function countAutoSyncBaseApps(db: DbClient): Promise<number> {
	const apps = coreTable(db, schemaApps);
	return db.$count(
		apps,
		syncEnabled(db, apps.metadata, ["mcpConfig", "autoSync"]),
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
	"id" | "slug" | "name" | "organizationId" | "metadata"
>;

/** Narrow organization-scoped seed projection for app-reference traversal. */
export async function listAppReferenceMetadataByOrganization(
	db: DbClient,
	organizationId: string,
): Promise<AppReferenceMetadataRow[]> {
	const apps = coreTable(db, schemaApps);
	return db
		.select({
			id: apps.id,
			slug: apps.slug,
			name: apps.name,
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
	const apps = coreTable(db, schemaApps);
	const rows: AppReferenceMetadataRow[] = [];
	const normalizedSlugs = [
		...new Set(slugs.map((slug) => slug.trim().toLowerCase()).filter(Boolean)),
	];
	if (normalizedSlugs.length) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					name: apps.name,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
				})
				.from(apps)
				.where(anyIds(db, apps.slug, normalizedSlugs))),
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
	const apps = coreTable(db, schemaApps);
	const rows: AppReferenceMetadataRow[] = [];
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	if (uniqueIds.length) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					name: apps.name,
					organizationId: apps.organizationId,
					metadata: apps.metadata,
				})
				.from(apps)
				.where(anyIds(db, apps.id, uniqueIds))),
		);
	}
	return rows;
}

export type PreviewSourceAppRow = AppReferenceMetadataRow & {
	sourceOrgSlug: string;
	sourceOrgTenantId: string | null;
};

/** Resolve aggregate preview sources and their ownership in one set lookup. */
export async function listPreviewSourceAppsBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<PreviewSourceAppRow[]> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const rows: PreviewSourceAppRow[] = [];
	const normalizedSlugs = [
		...new Set(slugs.map((slug) => slug.trim().toLowerCase()).filter(Boolean)),
	];
	if (normalizedSlugs.length) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					name: apps.name,
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
				.where(anyIds(db, apps.slug, normalizedSlugs))),
		);
	}
	return rows;
}

/** {@link listPreviewSourceAppsBySlugs} for entries that link by `appId`. */
export async function listPreviewSourceAppsByIds(
	db: DbClient,
	ids: string[],
): Promise<PreviewSourceAppRow[]> {
	const apps = coreTable(db, schemaApps);
	const organizations = coreTable(db, schemaOrganizations);
	const rows: PreviewSourceAppRow[] = [];
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	if (uniqueIds.length) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					slug: apps.slug,
					name: apps.name,
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
				.where(anyIds(db, apps.id, uniqueIds))),
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
	const apps = coreTable(db, schemaApps);
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

// ============================================================================
// Inherited Logos
// ============================================================================

type AppLogoLineage = Pick<
	App,
	"id" | "logoUrl" | "sourceAppId" | "catalogAppId"
>;

function present(value: string | null | undefined): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * The logo an app inherits when it has none of its own: its base app's logo
 * (`source_app_id`), else the base app's catalog logo, else its own catalog
 * entry's logo. Only apps without their own logo that inherit one appear in
 * the result.
 */
export async function getInheritedAppLogos(
	db: DbClient,
	rows: readonly AppLogoLineage[],
): Promise<Map<string, string>> {
	const apps = coreTable(db, schemaApps);
	const appCatalog = coreTable(db, schemaAppCatalog);
	const pending = rows.filter((row) => !present(row.logoUrl));
	const inherited = new Map<string, string>();
	if (pending.length === 0) return inherited;

	const sourceIds = [
		...new Set(pending.map((row) => row.sourceAppId).filter(present)),
	];
	const sources = new Map<
		string,
		{ logoUrl: string | null; catalogAppId: string | null }
	>();
	if (sourceIds.length) {
		const found = await db
			.select({
				id: apps.id,
				logoUrl: apps.logoUrl,
				catalogAppId: apps.catalogAppId,
			})
			.from(apps)
			.where(anyIds(db, apps.id, sourceIds));
		for (const source of found) sources.set(source.id, source);
	}

	const catalogIds = [
		...new Set(
			pending
				.flatMap((row) => [
					row.catalogAppId,
					row.sourceAppId ? sources.get(row.sourceAppId)?.catalogAppId : null,
				])
				.filter(present),
		),
	];
	const catalogLogos = new Map<string, string>();
	if (catalogIds.length) {
		const found = await db
			.select({ id: appCatalog.id, logoUrl: appCatalog.logoUrl })
			.from(appCatalog)
			.where(anyIds(db, appCatalog.id, catalogIds));
		for (const entry of found) {
			if (present(entry.logoUrl)) catalogLogos.set(entry.id, entry.logoUrl);
		}
	}

	for (const row of pending) {
		const source = row.sourceAppId ? sources.get(row.sourceAppId) : undefined;
		const logo =
			(present(source?.logoUrl) ? source.logoUrl : undefined) ??
			(source?.catalogAppId
				? catalogLogos.get(source.catalogAppId)
				: undefined) ??
			(row.catalogAppId ? catalogLogos.get(row.catalogAppId) : undefined);
		if (logo) inherited.set(row.id, logo);
	}
	return inherited;
}
