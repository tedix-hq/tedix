/**
 * App Catalog Queries — Install from catalog.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, eq, isNull } from "drizzle-orm";
import { apps } from "../../schema/index";
import { getCatalogAppById } from "./get-app";
import {
	type ConnectionScope,
	type Database,
	inferCatalogConnectionScope,
	readAppMcpConfig,
	renderableLogoUrl,
} from "./tool-source-policy";

// =============================================================================
// INSTALL FROM CATALOG
// =============================================================================

export interface InstallFromCatalogOptions {
	catalogAppId: string;
	organizationId: string;
	slug?: string;
	name?: string;
	description?: string;
	visibility?: "public" | "private";
	connectionProviderId?: string;
	connectionScope?: ConnectionScope;
	connectionScopes?: string[];
}

/**
 * Install a catalog app as an org-owned zero-tool proxy app.
 *
 * Steps:
 * 1. Fetch the catalog app by ID
 * 2. Find the platform base app linked to this catalog entry (source_app_id IS NULL)
 * 3. Create the org app with source_app_id = base app ID
 * 4. Point the org app at the base app through mcpConfig.aggregateApps
 *
 * The MCP Worker serves tools by resolving the proxy app's aggregateApps through
 * D1 base app rows. Tenant/project apps should not duplicate app_tools rows.
 *
 * Throws if no base app exists for the catalog entry. Run createBaseAppFromCatalog
 * first, or syncCatalogToolsToApp after creating an explicit base/custom app.
 */
export async function installFromCatalog(
	db: Database,
	options: InstallFromCatalogOptions,
) {
	const {
		catalogAppId,
		organizationId,
		slug,
		name,
		description,
		visibility,
		connectionProviderId,
		connectionScope,
		connectionScopes,
	} = options;

	// 1. Fetch the catalog app
	const catalogApp = await getCatalogAppById(db, catalogAppId);
	if (!catalogApp) {
		throw new Error(`Catalog app not found: ${catalogAppId}`);
	}

	// 2. Find the platform base app linked to this catalog entry
	const baseApps = await db
		.select()
		.from(apps)
		.where(and(eq(apps.catalogAppId, catalogAppId), isNull(apps.sourceAppId)))
		.limit(1);

	const baseApp = baseApps[0];
	if (!baseApp) {
		throw new Error(
			`No base app found for catalog entry "${catalogApp.name}" (${catalogAppId}). ` +
				`Run createBaseAppFromCatalog to create the base app first, then install.`,
		);
	}

	// Idempotent: if this org already has a proxy for this catalog entry,
	// backfill its logoUrl (self-heal, same precedence as create) and return
	// it instead of inserting a duplicate that would collide on the
	// deterministic org+slug unique constraint.
	const existingProxies = await db
		.select()
		.from(apps)
		.where(
			and(
				eq(apps.catalogAppId, catalogAppId),
				eq(apps.organizationId, organizationId),
				eq(apps.sourceAppId, baseApp.id),
			),
		)
		.limit(1);
	const existingProxy = existingProxies[0];
	if (existingProxy) {
		const nextLogoUrl =
			renderableLogoUrl(existingProxy.logoUrl) ??
			renderableLogoUrl(baseApp.logoUrl) ??
			renderableLogoUrl(catalogApp.logoUrl);
		if (nextLogoUrl !== null && nextLogoUrl !== existingProxy.logoUrl) {
			await db
				.update(apps)
				.set({ logoUrl: nextLogoUrl, updatedAt: new Date().toISOString() })
				.where(eq(apps.id, existingProxy.id));
			existingProxy.logoUrl = nextLogoUrl;
		}
		return {
			app: existingProxy,
			catalogAppId: catalogApp.id,
			catalogAppName: catalogApp.name,
			sourceAppId: baseApp.id,
			sourceAppSlug: baseApp.slug,
		};
	}

	const baseMcpConfig = readAppMcpConfig(baseApp);
	const effectiveConnectionProviderId =
		connectionProviderId ?? baseMcpConfig.connectionProviderId;
	const effectiveConnectionScope = inferCatalogConnectionScope(
		catalogApp,
		connectionScope,
		baseMcpConfig.connectionScope,
	);
	const effectiveConnectionScopes =
		connectionScopes ?? baseMcpConfig.connectionScopes;

	// 3. Create org-owned proxy shell. Tool rows stay on the platform base app.
	const appId = crypto.randomUUID();
	const now = new Date().toISOString();
	const appSlug = slug || `${baseApp.slug}-${organizationId.slice(0, 8)}`;
	const appName = name || catalogApp.name;
	const appDescription = description || catalogApp.description || null;
	const appLogoUrl =
		renderableLogoUrl(baseApp.logoUrl) ?? renderableLogoUrl(catalogApp.logoUrl);

	await db.insert(apps).values({
		id: appId,
		organizationId,
		name: appName,
		slug: appSlug,
		description: appDescription,
		logoUrl: appLogoUrl,
		visibility: visibility || "private",
		discoveryStatus: "pending",
		metadata: {
			mcpConfig: {
				authMode: "authenticated",
				...(effectiveConnectionProviderId
					? { connectionProviderId: effectiveConnectionProviderId }
					: {}),
				connectionScope: effectiveConnectionScope,
				...(effectiveConnectionScopes?.length
					? { connectionScopes: effectiveConnectionScopes }
					: {}),
				aggregateApps: [{ slug: baseApp.slug }],
			},
		},
		catalogAppId: catalogAppId,
		sourceAppId: baseApp.id,
		createdAt: now,
		updatedAt: now,
	});

	const createdApp = await db
		.select()
		.from(apps)
		.where(eq(apps.id, appId))
		.limit(1);

	return {
		app: createdApp[0],
		catalogAppId: catalogApp.id,
		catalogAppName: catalogApp.name,
		sourceAppId: baseApp.id,
		sourceAppSlug: baseApp.slug,
	};
}
