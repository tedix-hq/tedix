/**
 * App Catalog Queries — Create base app from catalog.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { apps } from "../../schema/index";
import { generateSlug, getCatalogAppById } from "./get-app";
import { syncCatalogToolsToApp } from "./sync-tools-to-app";
import {
	type ConnectionScope,
	catalogAppUsesConnection,
	type Database,
	inferCatalogConnectionScope,
	readAppMcpConfig,
	renderableLogoUrl,
} from "./tool-source-policy";

// =============================================================================
// CREATE BASE APP FROM CATALOG (catalog → new platform base app + sync tools)
// =============================================================================

export async function backfillCatalogBaseAppAutoSync(
	db: Database,
	options: { limit?: number } = {},
): Promise<number> {
	const limit = Math.min(Math.max(options.limit ?? 500, 1), 10_000);
	const rows = await db
		.select()
		.from(apps)
		.where(and(isNull(apps.sourceAppId), sql`${apps.catalogAppId} IS NOT NULL`))
		.limit(limit);

	let updated = 0;
	const now = new Date().toISOString();
	for (const app of rows) {
		const metadata =
			typeof app.metadata === "object" && app.metadata !== null
				? (app.metadata as Record<string, unknown>)
				: {};
		const mcpConfig =
			typeof metadata.mcpConfig === "object" && metadata.mcpConfig !== null
				? (metadata.mcpConfig as Record<string, unknown>)
				: {};
		if (typeof mcpConfig.autoSync === "boolean") continue;
		await db
			.update(apps)
			.set({
				metadata: {
					...metadata,
					mcpConfig: {
						...mcpConfig,
						autoSync: true,
					},
				},
				updatedAt: now,
			})
			.where(eq(apps.id, app.id));
		updated++;
	}
	return updated;
}

export interface CreateBaseAppFromCatalogOptions {
	catalogAppId: string;
	/** Org that will own the base app — defaults to deriving slug from catalog slug */
	organizationId: string;
	/** Override the generated slug. Defaults to catalogApp.slug. */
	slug?: string;
	/** Override name. Defaults to catalogApp.name. */
	name?: string;
	/** Pass through to syncCatalogToolsToApp */
	connectionProviderId?: string;
	connectionScope?: ConnectionScope;
	connectionScopes?: string[];
	dryRun?: boolean;
}

/**
 * Create a platform base app from a catalog entry and immediately sync its tools.
 *
 * Steps:
 * 1. Fetch the catalog app
 * 2. Create the base app (slug = catalogApp.slug)
 * 3. syncCatalogToolsToApp to create/update catalog tools as D1 rows (transport: "mcp")
 *
 * If a base app already exists (same catalogAppId + source_app_id IS NULL), returns
 * it and syncs tools to pick up any new/changed catalog tools.
 */
export async function createBaseAppFromCatalog(
	db: Database,
	options: CreateBaseAppFromCatalogOptions,
) {
	const {
		catalogAppId,
		organizationId,
		slug,
		name,
		connectionProviderId,
		connectionScope,
		connectionScopes,
		dryRun = false,
	} = options;

	const catalogApp = await getCatalogAppById(db, catalogAppId);
	if (!catalogApp) throw new Error(`Catalog app not found: ${catalogAppId}`);

	const mcpServerUrl = catalogApp.mcpEndpointNormalized || catalogApp.baseUrl;
	if (!mcpServerUrl)
		throw new Error(`Catalog app "${catalogApp.name}" has no MCP endpoint`);

	// Idempotent: return existing base app if already created
	const existing = await db
		.select()
		.from(apps)
		.where(and(eq(apps.catalogAppId, catalogAppId), isNull(apps.sourceAppId)))
		.limit(1);

	let baseApp = existing[0];
	let created = false;
	let plannedNewBaseApp = false;
	let adoptedOrphan = false;

	// Orphan adoption: a base app can exist at the target slug with no
	// catalogAppId (e.g. hand-created before the catalog row existed, or a
	// linkage that was never set). Insert would collide on the org+slug
	// unique constraint, so adopt the existing row by linking it instead of
	// treating this as a fresh create.
	if (!baseApp) {
		const appSlugForOrphanLookup =
			slug ||
			catalogApp.slug ||
			generateSlug(catalogApp.name, { baseUrl: mcpServerUrl });
		const orphan = (
			await db
				.select()
				.from(apps)
				.where(
					and(
						eq(apps.organizationId, organizationId),
						eq(apps.slug, appSlugForOrphanLookup),
						isNull(apps.sourceAppId),
						isNull(apps.catalogAppId),
					),
				)
				.limit(1)
		)[0];
		if (orphan) {
			adoptedOrphan = true;
			if (!dryRun) {
				await db
					.update(apps)
					.set({ catalogAppId, updatedAt: new Date().toISOString() })
					.where(eq(apps.id, orphan.id));
			}
			baseApp = { ...orphan, catalogAppId };
		}
	}

	const baseMcpConfig = baseApp ? readAppMcpConfig(baseApp) : {};
	// Connection/OAuth catalog apps default their provider id to the catalog
	// slug so synced tools get auth.type:"connection" (else auth:null → 401).
	// Explicit input and any already-stored provider take precedence.
	const effectiveConnectionProviderId =
		connectionProviderId ??
		baseMcpConfig.connectionProviderId ??
		(catalogAppUsesConnection(catalogApp)
			? (catalogApp.slug ?? undefined)
			: undefined);
	const effectiveConnectionScope = inferCatalogConnectionScope(
		catalogApp,
		connectionScope,
		baseMcpConfig.connectionScope,
	);
	const effectiveConnectionScopes =
		connectionScopes ?? baseMcpConfig.connectionScopes;
	const catalogLogoUrl = renderableLogoUrl(catalogApp.logoUrl);

	if (!baseApp) {
		const appId = crypto.randomUUID();
		const now = new Date().toISOString();
		const appSlug =
			slug ||
			catalogApp.slug ||
			generateSlug(catalogApp.name, { baseUrl: mcpServerUrl });
		const appName = name || catalogApp.name;
		const plannedBaseApp: typeof apps.$inferSelect = {
			id: appId,
			organizationId,
			name: appName,
			slug: appSlug,
			description: catalogApp.description || null,
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: "draft",
			primaryDomain: null,
			logoUrl: catalogLogoUrl,
			visibility: "public",
			discoveryStatus: "pending",
			metadata: {
				mcpConfig: {
					authMode: "authenticated",
					autoSync: true,
					...(effectiveConnectionProviderId
						? { connectionProviderId: effectiveConnectionProviderId }
						: {}),
					connectionScope: effectiveConnectionScope,
					...(effectiveConnectionScopes?.length
						? { connectionScopes: effectiveConnectionScopes }
						: {}),
				},
			},
			gatingMetadata: null,
			sourceAppId: null,
			catalogAppId,
			activeConfigVersionId: null,
			latestConfigVersion: 0,
			extractedAt: null,
			aiSearchSyncedAt: null,
			createdAt: now,
			updatedAt: now,
		};

		if (dryRun) {
			baseApp = plannedBaseApp;
			plannedNewBaseApp = true;
		} else {
			await db.insert(apps).values(plannedBaseApp);

			const rows = await db
				.select()
				.from(apps)
				.where(eq(apps.id, appId))
				.limit(1);
			baseApp = rows[0];
			created = true;
		}
	} else if (!dryRun) {
		const metadata =
			typeof baseApp.metadata === "object" && baseApp.metadata !== null
				? (baseApp.metadata as Record<string, unknown>)
				: {};
		const mcpConfig =
			typeof metadata.mcpConfig === "object" && metadata.mcpConfig !== null
				? (metadata.mcpConfig as Record<string, unknown>)
				: {};
		const storedMcpConfig = { ...(mcpConfig as Record<string, unknown>) };
		delete storedMcpConfig.upstreamMcpUrl;
		const nextMcpConfig = {
			...storedMcpConfig,
			autoSync:
				typeof mcpConfig.autoSync === "boolean" ? mcpConfig.autoSync : true,
			authMode:
				typeof mcpConfig.authMode === "string"
					? mcpConfig.authMode
					: "authenticated",
			...(effectiveConnectionProviderId
				? { connectionProviderId: effectiveConnectionProviderId }
				: {}),
			connectionScope: effectiveConnectionScope,
			...(effectiveConnectionScopes?.length
				? { connectionScopes: effectiveConnectionScopes }
				: {}),
		};
		const nextLogoUrl =
			renderableLogoUrl(baseApp.logoUrl) ?? catalogLogoUrl ?? null;
		const shouldUpdateLogoUrl =
			nextLogoUrl !== null && nextLogoUrl !== baseApp.logoUrl;
		await db
			.update(apps)
			.set({
				metadata: {
					...metadata,
					mcpConfig: nextMcpConfig,
				},
				...(shouldUpdateLogoUrl ? { logoUrl: nextLogoUrl } : {}),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(apps.id, baseApp.id));
		baseApp = {
			...baseApp,
			...(shouldUpdateLogoUrl ? { logoUrl: nextLogoUrl } : {}),
			metadata: {
				...metadata,
				mcpConfig: nextMcpConfig,
			},
		};
	}

	if (!baseApp) throw new Error("Failed to create base app");

	const sync = await syncCatalogToolsToApp(db, {
		catalogAppId,
		appId: baseApp.id,
		mcpServerUrl,
		connectionProviderId: effectiveConnectionProviderId,
		connectionScope: effectiveConnectionScope,
		connectionScopes: effectiveConnectionScopes,
		dryRun,
		targetAppOverride: dryRun ? baseApp : undefined,
		existingToolsOverride: plannedNewBaseApp ? [] : undefined,
	});

	return {
		app: baseApp,
		created,
		adoptedOrphan,
		sync,
	};
}
