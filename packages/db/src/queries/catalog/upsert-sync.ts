/**
 * App Catalog Queries — Upsert/sync operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { eq, sql } from "drizzle-orm";
import {
	type AuthType,
	appCatalog,
	type CatalogApp,
	type CatalogStoreListing,
	type Category,
	type ConnectorType,
	type DeveloperType,
	type DistributionChannel,
	type NewAppCatalogChange,
	type ReviewStatus,
	type Source,
} from "../../schema/catalog";
import { recordCatalogChange, recordCatalogChanges } from "./change-tracking";
import {
	getCanonicalCatalogAppForConnector,
	getCatalogAppByMcpEndpointHash,
	hashMcpEndpoint,
	isTemplatedMcpEndpoint,
	normalizeMcpEndpoint,
} from "./endpoint-normalization";
import { generateUniqueCatalogAppSlug, getCatalogAppById } from "./get-app";
import { isLookalikeCatalogName } from "./lookalike-names";
import {
	getCatalogStoreListingBySourceId,
	upsertCatalogStoreListing,
} from "./store-listings";
import {
	type CatalogAppStatus,
	type Database,
	incomingLogoRepairFailed,
	isExternalCatalogLogoUrl,
	isTedixCatalogAssetUrl,
	mergeCatalogRawData,
	mergeRichContent,
	normalizeRichContent,
	toISODate,
} from "./tool-source-policy";

// =============================================================================
// UPSERT/SYNC OPERATIONS
// =============================================================================

/**
 * Input for syncing an app from a store (ChatGPT, Claude, etc.)
 * This is the new multi-store aware input format
 */
export interface SyncCatalogAppInput {
	// App identity from the source store
	source: Source;
	sourceAppId: string;
	/** Original submission/creation time in the source store */
	sourceCreatedAt?: string | null;

	// Core app data
	name: string;
	description?: string | null;
	modelDescription?: string | null;
	baseUrl?: string | null; // MCP endpoint URL

	// Classification
	connectorType: ConnectorType;
	distributionChannel?: DistributionChannel | null;
	developerType?: DeveloperType | null;
	status?: string | null;

	// Branding
	category?: Category | null;
	developer?: string | null;
	website?: string | null;
	privacyPolicy?: string | null;
	termsOfService?: string | null;
	logoUrl?: string | null;
	logoUrlDark?: string | null;
	service?: string | null;

	// App Metadata
	version?: string | null;
	versionId?: string | null;
	versionNotes?: string | null;
	seoDescription?: string | null;
	screenshots?: string[] | null;
	categories?: string[] | null;
	subCategories?: string[] | null;

	// Capabilities
	hasWrites?: boolean;
	hasInteractive?: boolean;
	hasFileSearch?: boolean;
	hasDeepResearch?: boolean;
	hasSync?: boolean;

	// Auth
	authTypes?: AuthType[] | null;
	authRequired?: boolean;

	// Discovery
	isDiscoverable?: boolean;
	keywordsForDiscovery?: string[] | null;
	keywordsForTriggering?: string[] | null;

	// Store-specific
	regions?: string[] | null;
	storeUrl?: string | null;
	reviewStatus?: ReviewStatus | null;
	supportsFullActions?: boolean | null;
	safetyStatus?: string | null;

	// System Hints (JSON blob — tierLevel, isDangerous, badgeText, etc.)
	systemHints?: {
		tierLevel?: string | null;
		isDangerous?: boolean | null;
		badgeText?: string | null;
		estimatedDurationSeconds?: number | null;
		isFeatured?: boolean | null;
		svgLogo?: string | null;
		keywordInvocations?: string[] | null;
		actionLabel?: string | null;
		shortLabel?: string | null;
		suggestedPromptTheme?: string | null;
		allowInTemporaryChat?: boolean | null;
		persistBetweenMessages?: boolean | null;
	} | null;

	// Quality scores from registry metadata.
	scores?: {
		overall?: number | null;
		schemaQuality?: number | null;
		capabilityBreadth?: number | null;
		freshness?: number | null;
		standards?: number | null;
		trust?: number | null;
		lastCalculatedAt?: string | null;
		implementsRetrievable?: boolean | null;
		retrievableReason?: string | null;
	} | null;

	// Documentation & Support
	documentationUrl?: string | null;
	supportUrl?: string | null;

	// Rich Content (stored as JSON blob due to D1 100-column limit)
	richContent?: {
		htmlDescription?: string | null;
		heroVideoId?: string | null;
		heroVideoPreviewLink?: string | null;
		installCommand?: string | null;
		serverLabel?: string | null;
		publishedAt?: string | null;
		sourceUpdatedAt?: string | null;
		screenshotUrl?: string | null;
		enrichmentError?: string | null;
	} | null;

	// Per-store scoring (stored on store_listings, not catalog entry)
	popularityScore?: number | null;
	trendingScore?: number | null;
	rank?: number | null;
	worksWith?: string[] | null;

	// Directory tracking
	seenInDirectory?: boolean;

	// Raw data for preservation
	rawData?: Record<string, JsonValue> | null;
}

/**
 * Sync a catalog app from a store source
 *
 * Deduplication strategy:
 * - For MCP apps with a concrete endpoint: deduplicate by normalized endpoint hash
 * - Without one (no URL, a `{url}` template, or a non-MCP connector): attach to
 *   the same-vendor row when exactly one exists, else create a new entry
 *
 * Returns the catalog app and whether it was newly created
 */
export async function syncCatalogAppFromStore(
	db: Database,
	input: SyncCatalogAppInput,
	options: { allowCreate?: boolean } = {},
): Promise<{
	app: CatalogApp;
	created: boolean;
	storeListing: CatalogStoreListing;
} | null> {
	const now = new Date().toISOString();
	const allowCreate = options.allowCreate ?? true;

	// Compute endpoint normalization for MCP apps
	let mcpEndpointNormalized: string | null = null;
	let mcpEndpointHash: string | null = null;

	const shouldDedupByEndpoint = input.connectorType === "MCP";

	if (shouldDedupByEndpoint && input.baseUrl) {
		mcpEndpointNormalized = normalizeMcpEndpoint(input.baseUrl);
		if (mcpEndpointNormalized) {
			mcpEndpointHash = await hashMcpEndpoint(mcpEndpointNormalized);
		}
	}

	// Find existing app by endpoint hash (for MCP) or create new
	let existingApp: CatalogApp | null = null;
	let created = false;

	if (shouldDedupByEndpoint && mcpEndpointHash) {
		// MCP app: deduplicate by endpoint
		existingApp = await getCatalogAppByMcpEndpointHash(db, mcpEndpointHash);
	}

	if (!existingApp) {
		const existingListing = await getCatalogStoreListingBySourceId(
			db,
			input.source,
			input.sourceAppId,
		);
		if (existingListing) {
			existingApp = await getCatalogAppById(db, existingListing.catalogAppId);
		}
	}

	// Vendor-identity canonicalization. Any input with no dedup-able endpoint —
	// a store-brokered SERVICE connector, an MCP row whose store hides the URL
	// (first-party ChatGPT connectors), or a directory entry whose URL is a
	// `{url}` template — cannot be matched by endpoint hash, so without this it
	// spawns a standalone duplicate row (this is how `github-3` was minted beside
	// the official `github`). Fold it onto the existing row for the same vendor
	// (registrable domain + exact name) and attach it as a store-listing facet.
	// A template input first looks for a same-vendor template row (the same
	// user-supplied-server listing seen again), then for the runnable row.
	// Attach-only: we do NOT overwrite the canonical row's core fields
	// (endpoint, connectorType, distribution channel) with the listing's thin
	// metadata. Inputs with a concrete endpoint never take this path, so
	// per-store endpoint variants of one vendor stay separate rows.
	let attachOnly = false;
	if (!existingApp && !mcpEndpointHash) {
		const vendor = { website: input.website, name: input.name };
		const canonical =
			(isTemplatedMcpEndpoint(input.baseUrl)
				? await getCanonicalCatalogAppForConnector(db, {
						...vendor,
						templateEndpoint: true,
					})
				: null) ?? (await getCanonicalCatalogAppForConnector(db, vendor));
		if (canonical) {
			existingApp = canonical;
			attachOnly = true;
		}
	}

	let catalogApp: CatalogApp;

	if (existingApp && attachOnly) {
		// Canonicalized brokered connector: keep the canonical row intact and only
		// record that it was seen again in this source. The store listing (added
		// below) carries the per-source connector evidence.
		catalogApp = existingApp;
		await db
			.update(appCatalog)
			.set({ lastSyncedAt: now, updatedAt: sql`datetime('now')` })
			.where(eq(appCatalog.id, existingApp.id));
	} else if (existingApp) {
		const isUsableLogo = (url: unknown) =>
			typeof url === "string" &&
			(url.startsWith("data:") ||
				url.startsWith("http://") ||
				url.startsWith("https://"));

		const shouldClearExistingLogo =
			incomingLogoRepairFailed(input.rawData) &&
			isExternalCatalogLogoUrl(existingApp.logoUrl);

		const nextLogoUrl =
			input.logoUrl &&
			(!isUsableLogo(existingApp.logoUrl) ||
				existingApp.logoUrl == null ||
				(isTedixCatalogAssetUrl(input.logoUrl) &&
					!isTedixCatalogAssetUrl(existingApp.logoUrl)))
				? input.logoUrl
				: shouldClearExistingLogo
					? null
					: existingApp.logoUrl;

		const nextLogoUrlDark =
			input.logoUrlDark &&
			(!isUsableLogo(existingApp.logoUrlDark) ||
				existingApp.logoUrlDark == null ||
				(isTedixCatalogAssetUrl(input.logoUrlDark) &&
					!isTedixCatalogAssetUrl(existingApp.logoUrlDark)))
				? input.logoUrlDark
				: existingApp.logoUrlDark;

		const nextScreenshots =
			input.screenshots && input.screenshots.length > 0
				? existingApp.screenshots &&
					existingApp.screenshots.length > 0 &&
					!(
						input.screenshots.some(isTedixCatalogAssetUrl) &&
						!existingApp.screenshots.some(isTedixCatalogAssetUrl)
					)
					? existingApp.screenshots
					: input.screenshots
				: existingApp.screenshots;

		const nextSeoDescription =
			input.seoDescription && !existingApp.seoDescription
				? input.seoDescription
				: existingApp.seoDescription;

		const nextCategories =
			input.categories && input.categories.length > 0
				? existingApp.categories && existingApp.categories.length > 0
					? existingApp.categories
					: input.categories
				: existingApp.categories;

		const incomingCategory =
			input.category ?? (input.categories?.[0] as Category | undefined) ?? null;
		const existingCategory =
			existingApp.category ??
			(existingApp.categories?.[0] as Category | undefined) ??
			null;

		// Change detection: track field-level diffs before updating
		const changesToRecord: NewAppCatalogChange[] = [];
		const trackedFields = [
			{ field: "name", old: existingApp.name, new: input.name },
			{
				field: "description",
				old: existingApp.description,
				new: input.description,
			},
			{ field: "status", old: existingApp.status, new: input.status },
			{ field: "category", old: existingApp.category, new: input.category },
			{ field: "developer", old: existingApp.developer, new: input.developer },
			{ field: "version", old: existingApp.version, new: input.version },
			{
				field: "versionNotes",
				old: existingApp.versionNotes,
				new: input.versionNotes,
			},
			{ field: "logoUrl", old: existingApp.logoUrl, new: input.logoUrl },
		];

		for (const { field, old: oldVal, new: newVal } of trackedFields) {
			if (newVal != null && oldVal !== newVal) {
				const isVersionBump = field === "version";
				changesToRecord.push({
					id: crypto.randomUUID(),
					catalogAppId: existingApp.id,
					changeType: isVersionBump ? "version_bump" : "updated",
					fieldName: field,
					oldValue: oldVal ?? null,
					newValue: newVal,
					versionBefore: isVersionBump ? (oldVal ?? null) : null,
					versionAfter: isVersionBump ? newVal : null,
					detectedAt: new Date().toISOString(),
				});
			}
		}

		if (changesToRecord.length > 0) {
			await recordCatalogChanges(db, changesToRecord);
		}

		const normalizedExisting = toISODate(existingApp.sourceCreatedAt);
		const normalizedInput = toISODate(input.sourceCreatedAt);
		const mergedSourceCreatedAt =
			normalizedExisting && normalizedInput
				? normalizedExisting <= normalizedInput
					? normalizedExisting
					: normalizedInput
				: (normalizedExisting ?? normalizedInput);

		// Update existing app with merged data
		// Also update endpoint fields if input provides a better/changed URL
		await db
			.update(appCatalog)
			.set({
				// Update basic info (prefer newer data), but never trade a clean
				// name for a lookalike spelling of it ("Composio" → "Cоmpоsiо").
				name:
					isLookalikeCatalogName(input.name) &&
					!isLookalikeCatalogName(existingApp.name)
						? existingApp.name
						: input.name,
				description: input.description ?? existingApp.description,
				modelDescription:
					input.modelDescription ?? existingApp.modelDescription,
				// Keep connectorType from first source
				distributionChannel:
					input.distributionChannel ?? existingApp.distributionChannel,
				developerType: input.developerType ?? existingApp.developerType,
				status: (input.status ??
					(existingApp.status === "DISABLED"
						? "ENABLED"
						: existingApp.status)) as CatalogAppStatus,
				category: incomingCategory ?? existingCategory,
				developer: input.developer ?? existingApp.developer,
				website: input.website ?? existingApp.website,
				privacyPolicy: input.privacyPolicy ?? existingApp.privacyPolicy,
				termsOfService: input.termsOfService ?? existingApp.termsOfService,
				logoUrl: nextLogoUrl,
				logoUrlDark: nextLogoUrlDark,
				service: input.service ?? existingApp.service,
				version: input.version ?? existingApp.version,
				versionId: input.versionId ?? existingApp.versionId,
				versionNotes: input.versionNotes ?? existingApp.versionNotes,
				seoDescription: nextSeoDescription,
				screenshots: nextScreenshots,
				categories: nextCategories,
				subCategories: input.subCategories ?? existingApp.subCategories,
				reviewStatus: input.reviewStatus ?? existingApp.reviewStatus,
				supportsFullActions:
					input.supportsFullActions || existingApp.supportsFullActions,
				safetyStatus: input.safetyStatus ?? existingApp.safetyStatus,
				sourceCreatedAt: mergedSourceCreatedAt,
				// Update endpoint fields (prefer input if provided, keep existing otherwise)
				// This ensures endpoint data stays current as stores update their URLs
				baseUrl: input.baseUrl ?? existingApp.baseUrl,
				mcpEndpointNormalized:
					mcpEndpointNormalized ?? existingApp.mcpEndpointNormalized,
				mcpEndpointHash: mcpEndpointHash ?? existingApp.mcpEndpointHash,
				// Documentation & support (fill if missing)
				documentationUrl:
					input.documentationUrl ?? existingApp.documentationUrl,
				supportUrl: input.supportUrl ?? existingApp.supportUrl,
				// Merge capabilities (OR logic - if any store says true, it's true)
				hasWrites: input.hasWrites || existingApp.hasWrites,
				hasInteractive: input.hasInteractive || existingApp.hasInteractive,
				hasFileSearch: input.hasFileSearch || existingApp.hasFileSearch,
				hasDeepResearch: input.hasDeepResearch || existingApp.hasDeepResearch,
				hasSync: input.hasSync || existingApp.hasSync,
				// Discovery fields
				isDiscoverable: input.isDiscoverable ?? existingApp.isDiscoverable,
				keywordsForDiscovery:
					input.keywordsForDiscovery ?? existingApp.keywordsForDiscovery,
				keywordsForTriggering:
					input.keywordsForTriggering ?? existingApp.keywordsForTriggering,
				// System hints (JSON blob)
				systemHints: {
					...existingApp.systemHints,
					...input.systemHints,
					tierLevel:
						input.systemHints?.tierLevel ?? existingApp.systemHints?.tierLevel,
					isDangerous:
						input.systemHints?.isDangerous ??
						existingApp.systemHints?.isDangerous,
					badgeText:
						input.systemHints?.badgeText ?? existingApp.systemHints?.badgeText,
					estimatedDurationSeconds:
						input.systemHints?.estimatedDurationSeconds ??
						existingApp.systemHints?.estimatedDurationSeconds,
					isFeatured:
						input.systemHints?.isFeatured ||
						existingApp.systemHints?.isFeatured,
					svgLogo:
						input.systemHints?.svgLogo ?? existingApp.systemHints?.svgLogo,
					keywordInvocations:
						input.systemHints?.keywordInvocations ??
						existingApp.systemHints?.keywordInvocations,
					actionLabel:
						input.systemHints?.actionLabel ??
						existingApp.systemHints?.actionLabel,
					shortLabel:
						input.systemHints?.shortLabel ??
						existingApp.systemHints?.shortLabel,
					suggestedPromptTheme:
						input.systemHints?.suggestedPromptTheme ??
						existingApp.systemHints?.suggestedPromptTheme,
					allowInTemporaryChat:
						input.systemHints?.allowInTemporaryChat ??
						existingApp.systemHints?.allowInTemporaryChat,
					persistBetweenMessages:
						input.systemHints?.persistBetweenMessages ??
						existingApp.systemHints?.persistBetweenMessages,
				},
				// Scores: registry quality fields (JSON blob, merge with existing)
				scores: {
					...existingApp.scores,
					...input.scores,
					implementsRetrievable:
						input.scores?.implementsRetrievable ||
						existingApp.scores?.implementsRetrievable,
					retrievableReason:
						input.scores?.retrievableReason ??
						existingApp.scores?.retrievableReason,
				},
				// Auth types: update if incoming is more specific (non-null replaces null)
				authTypes: input.authTypes ?? existingApp.authTypes,
				// Rich content JSON (merge: incoming fills gaps, existing preserved)
				richContent: mergeRichContent(
					existingApp.richContent,
					input.richContent,
				),
				rawData: mergeCatalogRawData(existingApp.rawData, input.rawData),
				lastSyncedAt: now,
				// Re-enable delisted apps that reappear in a sync
				...(existingApp.status === "DELISTED"
					? { status: "ENABLED" as const, isDiscoverable: true }
					: {}),
				// First-seen tracking (JSON blob)
				firstSeen: {
					at: existingApp.firstSeen?.at ?? now,
					releasedAt:
						existingApp.firstSeen?.releasedAt ??
						(input.reviewStatus === "RELEASED" ? now : null),
					inDirectoryAt:
						existingApp.firstSeen?.inDirectoryAt ??
						(input.seenInDirectory ? now : null),
				},
				updatedAt: sql`datetime('now')`,
			})
			.where(eq(appCatalog.id, existingApp.id));

		catalogApp = existingApp;
	} else {
		if (!allowCreate) {
			return null;
		}
		const insertCategory =
			input.category ?? (input.categories?.[0] as Category | undefined) ?? null;
		// Create new catalog app
		const id = crypto.randomUUID();
		const slug = await generateUniqueCatalogAppSlug(db, input.name, {
			storeSourceId: input.sourceAppId,
			baseUrl: input.baseUrl,
			website: input.website,
		});

		await db.insert(appCatalog).values({
			id,
			slug,
			name: input.name,
			description: input.description,
			modelDescription: input.modelDescription,
			baseUrl: input.baseUrl,
			mcpEndpointNormalized,
			mcpEndpointHash,
			connectorType: input.connectorType,
			distributionChannel: input.distributionChannel,
			developerType: input.developerType,
			status: (input.status ?? "ENABLED") as CatalogAppStatus,
			category: insertCategory,
			developer: input.developer,
			website: input.website,
			privacyPolicy: input.privacyPolicy,
			termsOfService: input.termsOfService,
			logoUrl: input.logoUrl,
			logoUrlDark: input.logoUrlDark,
			service: input.service ?? null,
			documentationUrl: input.documentationUrl ?? null,
			supportUrl: input.supportUrl ?? null,
			version: input.version ?? null,
			versionId: input.versionId ?? null,
			versionNotes: input.versionNotes ?? null,
			seoDescription: input.seoDescription ?? null,
			screenshots: input.screenshots ?? null,
			categories: input.categories ?? null,
			subCategories: input.subCategories ?? null,
			reviewStatus: input.reviewStatus ?? null,
			supportsFullActions: input.supportsFullActions ?? null,
			scores: {
				...input.scores,
				implementsRetrievable: input.scores?.implementsRetrievable ?? null,
				retrievableReason: input.scores?.retrievableReason ?? null,
			},
			safetyStatus: input.safetyStatus ?? null,
			sourceCreatedAt: toISODate(input.sourceCreatedAt),
			hasWrites: input.hasWrites ?? false,
			hasInteractive: input.hasInteractive ?? false,
			hasFileSearch: input.hasFileSearch ?? false,
			hasDeepResearch: input.hasDeepResearch ?? false,
			hasSync: input.hasSync ?? false,
			// A name posing as another vendor via lookalike letters stays out of
			// browsing until reviewed.
			isDiscoverable: isLookalikeCatalogName(input.name)
				? false
				: (input.isDiscoverable ?? true),
			keywordsForDiscovery: input.keywordsForDiscovery ?? null,
			keywordsForTriggering: input.keywordsForTriggering ?? null,
			systemHints: {
				...input.systemHints,
				tierLevel: input.systemHints?.tierLevel ?? null,
				isDangerous: input.systemHints?.isDangerous ?? null,
				badgeText: input.systemHints?.badgeText ?? null,
				estimatedDurationSeconds:
					input.systemHints?.estimatedDurationSeconds ?? null,
				isFeatured: input.systemHints?.isFeatured ?? false,
				svgLogo: input.systemHints?.svgLogo ?? null,
				keywordInvocations: input.systemHints?.keywordInvocations ?? null,
				actionLabel: input.systemHints?.actionLabel ?? null,
				shortLabel: input.systemHints?.shortLabel ?? null,
				suggestedPromptTheme: input.systemHints?.suggestedPromptTheme ?? null,
				allowInTemporaryChat: input.systemHints?.allowInTemporaryChat ?? null,
				persistBetweenMessages:
					input.systemHints?.persistBetweenMessages ?? null,
			},
			authTypes: input.authTypes,
			// Rich content JSON
			richContent: normalizeRichContent(input.richContent),
			rawData: input.rawData ?? null,
			healthStatus: "unknown",
			lastSyncedAt: now,
			// First-seen tracking (JSON blob)
			firstSeen: {
				at: now,
				releasedAt: input.reviewStatus === "RELEASED" ? now : null,
				inDirectoryAt: input.seenInDirectory ? now : null,
			},
			// Per-store data lives in app_catalog_store_listings (upserted below)
		});

		catalogApp = (await getCatalogAppById(db, id))!;
		created = true;

		// Record "added" change for new apps
		await recordCatalogChange(db, {
			id: crypto.randomUUID(),
			catalogAppId: catalogApp.id,
			changeType: "added",
			detectedAt: new Date().toISOString(),
		});
	}

	// Normalize store listing for this source to avoid unique conflicts
	let existingListing = await getCatalogStoreListingBySourceId(
		db,
		input.source,
		input.sourceAppId,
	);

	// Always upsert the store listing
	const storeListing = await upsertCatalogStoreListing(db, {
		id: existingListing?.id ?? crypto.randomUUID(),
		catalogAppId: catalogApp.id,
		source: input.source,
		sourceAppId: input.sourceAppId,
		regions: input.regions,
		storeUrl: input.storeUrl,
		reviewStatus: input.reviewStatus,
		authRequired: input.authRequired ?? false,
		storeLogoUrl: input.logoUrl,
		storeDescription: input.description,
		popularityScore: input.popularityScore ?? null,
		trendingScore: input.trendingScore ?? null,
		rank: input.rank ?? null,
		worksWith: input.worksWith ?? null,
		lastSyncedAt: now,
		rawData: input.rawData,
	});

	return { app: catalogApp, created, storeListing };
}

/**
 * Bulk sync catalog apps from a store
 */
export async function bulkSyncCatalogAppsFromStore(
	db: Database,
	apps: SyncCatalogAppInput[],
	options: { allowCreate?: boolean } = {},
): Promise<{ inserted: number; updated: number; errors: string[] }> {
	let inserted = 0;
	let updated = 0;
	const errors: string[] = [];

	for (const app of apps) {
		try {
			const result = await syncCatalogAppFromStore(db, app, options);
			if (!result) {
				continue;
			}
			if (result.created) {
				inserted++;
			} else {
				updated++;
			}
		} catch (error) {
			// Drizzle wraps the useful D1 failure in cause; retain that diagnostic.
			let cause = error;
			const seen = new Set<unknown>();
			while (cause instanceof Error && cause.cause && !seen.has(cause.cause)) {
				seen.add(cause);
				cause = cause.cause;
			}
			const msg = cause instanceof Error ? cause.message : String(cause);
			errors.push(`Failed to sync ${app.name} (${app.sourceAppId}): ${msg}`);
		}
	}

	return { inserted, updated, errors };
}
