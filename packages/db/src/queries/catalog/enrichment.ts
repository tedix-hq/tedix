/**
 * App Catalog Queries — Enrichment operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, or, sql } from "drizzle-orm";
import {
	appCatalog,
	type CatalogApp,
	type Category,
	categoryEnum,
	type NewCatalogApp,
} from "../../schema/catalog";
import { getCatalogAppById } from "./get-app";
import type { Database, RichContent } from "./tool-source-policy";

// =============================================================================
// ENRICHMENT OPERATIONS
// =============================================================================

/**
 * Extracted prompt from ChatGPT app page
 */
export interface ExtractedPromptData {
	raw: string;
	cleanPrompt: string;
	appMention: string;
	screenshotUrl?: string | null;
	sourceFileId?: string | null;
	confidence?: number | null;
	source?: "markdown" | "raw_html" | "sync";
}

/**
 * Enrichment data to update an app with
 */
export interface CatalogAppEnrichmentData {
	screenshotUrl?: string | null;
	/** Array of screenshot R2 URLs (from ChatGPT app store page estuary images) */
	screenshots?: string[] | null;
	enrichedDescription?: string | null;
	/** SEO description from ChatGPT app store page (rich markdown with sample prompts) */
	seoDescription?: string | null;
	socialLinks?: string[] | null;
	examplePrompts?: ExtractedPromptData[] | null;
	/** Logo URL uploaded to R2, or null when a known-bad public logo should be cleared. */
	logoUrl?: string | null;
	/** App categories from ChatGPT app store page */
	categories?: string[] | null;
	/** Developer name from ChatGPT app store page */
	developer?: string | null;
	/** Website URL extracted from app page (fallback only) */
	website?: string | null;
	/** Privacy policy URL extracted from app page (fallback only) */
	privacyPolicy?: string | null;
	/** Terms of service URL extracted from app page (fallback only) */
	termsOfService?: string | null;
	/** Version extracted from app page (fallback only) */
	version?: string | null;
	enrichmentSource?: string;
	/** Optional field-level provenance and confidence metadata */
	enrichmentMeta?: {
		confidence: number;
		provenance: Record<string, string>;
		slo?: {
			hasLogo: boolean;
			hasScreenshots: boolean;
			hasPrompts: boolean;
			hasLegalLinks: boolean;
		};
	} | null;
	enrichmentFailedAt?: string | null;
	enrichmentSkipped?: boolean;
	/** Mark app as permanently exempt from enrichment (connector apps without store pages) */
	enrichmentExempt?: boolean;
	/** Error message from last enrichment failure (stored in rich_content JSON) */
	enrichmentError?: string;
}

const MIN_PUBLIC_CATALOG_DESCRIPTION_LENGTH = 80;

/**
 * Get apps that need enrichment.
 *
 * Selection criteria (OR):
 * 1. Missing screenshots
 * 2. Enrichment is stale (enriched_at older than maxAgeHours)
 * 3. Thin public descriptions
 * 4. Logos/assets still not normalized into Tedix R2
 *
 * Prioritization:
 * 1. Never enriched apps first
 * 2. Oldest enrichment next
 * 3. MCP apps and those with more capabilities
 *
 * Exclusions:
 * - Apps permanently skipped (enrichmentSkipped = true)
 * - Non-discoverable apps
 * - Untrusted developers
 *
 * @param limit Max apps to return
 * @param maxAgeHours Re-enrich apps older than this (default 168 = 7 days)
 */
export async function getAppsNeedingEnrichment(
	db: Database,
	limit = 10,
	maxAgeHours = 168,
	options?: { forceBranding?: boolean; mode?: "full" | "logo-repair" },
): Promise<CatalogApp[]> {
	const cutoff = new Date(
		Date.now() - maxAgeHours * 60 * 60 * 1000,
	).toISOString();

	const logoBackfillCondition = or(
		sql`${appCatalog.logoUrl} IS NULL`,
		sql`trim(${appCatalog.logoUrl}) = ''`,
		sql`${appCatalog.logoUrl} LIKE 'connectors://%'`,
		sql`${appCatalog.logoUrl} LIKE 'https://www.google.com/s2/favicons%'`,
		sql`(${appCatalog.logoUrl} IS NOT NULL AND ${appCatalog.logoUrl} NOT LIKE 'http://%' AND ${appCatalog.logoUrl} NOT LIKE 'https://%' AND ${appCatalog.logoUrl} NOT LIKE 'data:%')`,
		// data: URIs are inline blobs — upload to R2 regardless of svgLogo fallback.
		sql`${appCatalog.logoUrl} LIKE 'data:%'`,
		// External assets are okay as source material but public catalog rows should
		// point at Tedix-hosted R2 assets so rendering is stable and cacheable.
		sql`(${appCatalog.logoUrl} LIKE 'http%' AND ${appCatalog.logoUrl} NOT LIKE '%/app_catalog/%')`,
		sql`json_extract(${appCatalog.rawData}, '$.quality.logoStatus') IN ('fallback_favicon', 'fetch_failed', 'missing', 'invalid')`,
	);
	const screenshotBackfillCondition = or(
		sql`json_extract(${appCatalog.richContent}, '$.screenshotUrl') IS NULL`,
		sql`trim(json_extract(${appCatalog.richContent}, '$.screenshotUrl')) = ''`,
		sql`json_extract(${appCatalog.rawData}, '$.quality.screenshotStatus') IN ('missing', 'partial', 'fetch_failed', 'invalid')`,
	);
	const weakDescriptionCondition = and(
		sql`${appCatalog.description} IS NOT NULL`,
		sql`length(trim(${appCatalog.description})) > 0`,
		sql`length(trim(${appCatalog.description})) < ${MIN_PUBLIC_CATALOG_DESCRIPTION_LENGTH}`,
		sql`(${appCatalog.seoDescription} IS NULL OR length(trim(${appCatalog.seoDescription})) < ${MIN_PUBLIC_CATALOG_DESCRIPTION_LENGTH})`,
		sql`(json_extract(${appCatalog.richContent}, '$.enrichedDescription') IS NULL OR length(trim(json_extract(${appCatalog.richContent}, '$.enrichedDescription'))) < ${MIN_PUBLIC_CATALOG_DESCRIPTION_LENGTH})`,
	);

	// When forceBranding is true, also include apps that have R2 logos ending in
	// .png or .jpg (not .svg). These were often enriched from OG images before
	// the Firecrawl branding format was implemented.
	const forcedBrandingCondition = sql`(${appCatalog.logoUrl} LIKE '%r2.dev%' AND ${appCatalog.logoUrl} NOT LIKE '%.svg')`;
	const hasBrandingSourceCondition = or(
		sql`${appCatalog.website} IS NOT NULL AND trim(${appCatalog.website}) != ''`,
		sql`${appCatalog.mcpEndpointNormalized} IS NOT NULL AND trim(${appCatalog.mcpEndpointNormalized}) != ''`,
	);
	const needsEnrichmentCondition =
		options?.mode === "logo-repair"
			? options.forceBranding
				? or(logoBackfillCondition, forcedBrandingCondition)
				: logoBackfillCondition
			: options?.forceBranding
				? or(
						screenshotBackfillCondition,
						sql`json_extract(${appCatalog.richContent}, '$.enrichedAt') < ${cutoff}`,
						sql`${appCatalog.categories} IS NULL`,
						logoBackfillCondition,
						weakDescriptionCondition,
						// forceBranding: R2 logos that are PNG/JPG (not SVG) need re-enrichment
						forcedBrandingCondition,
					)
				: or(
						screenshotBackfillCondition,
						sql`json_extract(${appCatalog.richContent}, '$.enrichedAt') < ${cutoff}`,
						sql`${appCatalog.categories} IS NULL`,
						logoBackfillCondition,
						weakDescriptionCondition,
					);

	const apps = await db
		.select()
		.from(appCatalog)
		.where(
			and(
				needsEnrichmentCondition,
				// Not permanently skipped (blocklisted, etc.)
				or(
					sql`json_extract(${appCatalog.richContent}, '$.enrichmentSkipped') IS NULL`,
					sql`json_extract(${appCatalog.richContent}, '$.enrichmentSkipped') = false`,
				),
				// Skip connector apps (SERVICE, FIRST_PARTY_ECOSYSTEM) — they have no app store pages with screenshots
				sql`${appCatalog.connectorType} NOT IN ('SERVICE', 'FIRST_PARTY_ECOSYSTEM')`,
				// Logo repair uses website branding only, so skip rows with no
				// reachable branding source instead of queueing guaranteed no-ops.
				options?.mode === "logo-repair"
					? hasBrandingSourceCondition
					: undefined,
				// Only discoverable apps from trusted sources
				eq(appCatalog.isDiscoverable, true),
				or(
					eq(appCatalog.developerType, "TRUSTED_PARTNER"),
					eq(appCatalog.developerType, "OAI"),
					eq(appCatalog.developerType, "THIRD_PARTY"),
				),
			),
		)
		// Prioritize: never enriched > missing categories > oldest enrichment > MCP > capabilities
		.orderBy(
			// Never enriched first (NULL enrichedAt = 0, has value = 1)
			sql`CASE WHEN json_extract(${appCatalog.richContent}, '$.enrichedAt') IS NULL THEN 0 ELSE 1 END`,
			// Then apps missing categories (NULL categories = 0, has value = 1)
			sql`CASE WHEN ${appCatalog.categories} IS NULL THEN 0 ELSE 1 END`,
			// Then asset backfill candidates.
			sql`CASE WHEN ${logoBackfillCondition} OR ${screenshotBackfillCondition} THEN 0 ELSE 1 END`,
			// Then weak public descriptions.
			sql`CASE WHEN ${weakDescriptionCondition} THEN 0 ELSE 1 END`,
			// Then oldest enrichment
			sql`json_extract(${appCatalog.richContent}, '$.enrichedAt')`,
			// Then MCP apps
			desc(
				sql`CASE WHEN ${appCatalog.connectorType} = 'MCP' THEN 1 ELSE 0 END`,
			),
			desc(appCatalog.hasInteractive),
			desc(appCatalog.hasWrites),
			desc(appCatalog.name),
		)
		.limit(limit);

	return apps;
}

/**
 * Sanitize a string for D1 storage: remove null bytes and other control characters
 * that SQLite TEXT columns cannot store.
 */
function sanitizeForD1(
	value: string | null | undefined,
): string | null | undefined {
	if (value == null) return value;
	return [...value]
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code === 9 || code === 10 || code === 13 || code >= 32;
		})
		.join("");
}

/**
 * Update app with enrichment data.
 *
 * Uses a typed update object (not Record<string, unknown>) so Drizzle's
 * column encoders correctly JSON.stringify() columns declared with
 * { mode: "json" } (screenshots, categories, examplePrompts, socialLinks).
 */
export async function updateCatalogAppEnrichment(
	db: Database,
	id: string,
	enrichmentData: CatalogAppEnrichmentData,
): Promise<CatalogApp | null> {
	const now = new Date().toISOString();

	// Use a typed partial matching the table's insert shape so Drizzle applies
	// the correct per-column mapToDriverValue (e.g. JSON.stringify for json-mode text columns).
	// Using Record<string, unknown> can bypass the column encoder in some Drizzle/D1 edge cases.
	// Allow SQL expressions (e.g. sql`datetime('now')`) alongside normal column values
	type CatalogUpdate = {
		[K in keyof NewCatalogApp]?: NewCatalogApp[K] | ReturnType<typeof sql>;
	};
	const updateData: CatalogUpdate = {
		updatedAt: sql`datetime('now')`,
	};

	// Read existing JSON blobs to merge (never overwrite unrelated fields)
	const existingRows = await db
		.select({
			richContent: appCatalog.richContent,
			rawData: appCatalog.rawData,
		})
		.from(appCatalog)
		.where(eq(appCatalog.id, id))
		.limit(1);

	const existingRc = (existingRows[0]?.richContent ?? {}) as RichContent;
	const rcUpdate: RichContent = { ...existingRc };
	const existingRaw =
		existingRows[0]?.rawData &&
		typeof existingRows[0].rawData === "object" &&
		!Array.isArray(existingRows[0].rawData)
			? (existingRows[0].rawData as Record<string, unknown>)
			: {};
	const existingQuality =
		existingRaw.quality &&
		typeof existingRaw.quality === "object" &&
		!Array.isArray(existingRaw.quality)
			? (existingRaw.quality as Record<string, unknown>)
			: {};
	const qualityUpdate: Record<string, unknown> = {};

	// Pack enrichment fields into richContent blob
	if (enrichmentData.screenshotUrl !== undefined) {
		rcUpdate.screenshotUrl = enrichmentData.screenshotUrl;
	}
	if (enrichmentData.enrichedDescription !== undefined) {
		rcUpdate.enrichedDescription = sanitizeForD1(
			enrichmentData.enrichedDescription,
		);
	}
	if (enrichmentData.socialLinks !== undefined) {
		rcUpdate.socialLinks = enrichmentData.socialLinks;
	}
	if (enrichmentData.examplePrompts !== undefined) {
		rcUpdate.examplePrompts = enrichmentData.examplePrompts;
	}
	if (enrichmentData.enrichmentSource) {
		rcUpdate.enrichmentSource = enrichmentData.enrichmentSource;
	}

	// Top-level columns that remain as-is
	if (enrichmentData.screenshots !== undefined) {
		updateData.screenshots = enrichmentData.screenshots;
	}
	if (enrichmentData.seoDescription !== undefined) {
		updateData.seoDescription = sanitizeForD1(enrichmentData.seoDescription);
	}
	if (enrichmentData.logoUrl !== undefined) {
		updateData.logoUrl = enrichmentData.logoUrl;
		if (enrichmentData.logoUrl) {
			qualityUpdate.logoStatus = "normalized";
			qualityUpdate.logoSource = "enrichment";
		} else {
			qualityUpdate.logoStatus = "missing";
			qualityUpdate.logoSource = "enrichment";
		}
	}
	if (enrichmentData.categories !== undefined) {
		updateData.categories = enrichmentData.categories;
		// Backfill the single `category` enum from the first enriched category
		// if it's currently null (sync didn't provide one)
		const firstKnownCategory = enrichmentData.categories?.find(
			(category): category is Category =>
				(categoryEnum as readonly string[]).includes(category),
		);
		if (firstKnownCategory) {
			updateData.category = firstKnownCategory;
		}
	}
	if (enrichmentData.developer !== undefined) {
		updateData.developer = sanitizeForD1(enrichmentData.developer);
	}
	if (enrichmentData.website !== undefined) {
		updateData.website = sanitizeForD1(enrichmentData.website);
	}
	if (enrichmentData.privacyPolicy !== undefined) {
		updateData.privacyPolicy = sanitizeForD1(enrichmentData.privacyPolicy);
	}
	if (enrichmentData.termsOfService !== undefined) {
		updateData.termsOfService = sanitizeForD1(enrichmentData.termsOfService);
	}
	if (enrichmentData.version !== undefined) {
		updateData.version = sanitizeForD1(enrichmentData.version);
	}
	if (enrichmentData.enrichmentMeta !== undefined) {
		updateData.rawData = sql`json_set(
			coalesce(${appCatalog.rawData}, '{}'),
			'$.enrichmentMeta',
			json(${JSON.stringify(enrichmentData.enrichmentMeta)})
		)`;
	}

	if (enrichmentData.screenshotUrl || enrichmentData.screenshots?.length) {
		qualityUpdate.screenshotStatus = "normalized";
		qualityUpdate.screenshotCount =
			enrichmentData.screenshots?.length ??
			(enrichmentData.screenshotUrl ? 1 : undefined);
		qualityUpdate.screenshotSource = "enrichment";
	}

	if (Object.keys(qualityUpdate).length > 0) {
		updateData.rawData = {
			...existingRaw,
			...(enrichmentData.enrichmentMeta !== undefined
				? { enrichmentMeta: enrichmentData.enrichmentMeta }
				: {}),
			quality: {
				...existingQuality,
				...qualityUpdate,
				lastAssetCheckedAt: now,
			},
		};
	}

	// If we have any meaningful enrichment data, mark as enriched
	if (
		enrichmentData.screenshotUrl ||
		enrichmentData.screenshots?.length ||
		enrichmentData.enrichedDescription ||
		enrichmentData.seoDescription ||
		enrichmentData.categories?.length
	) {
		rcUpdate.enrichedAt = now;
		rcUpdate.enrichmentFailedAt = null;
	}

	// Failure case: set error timestamp
	if (enrichmentData.enrichmentFailedAt !== undefined) {
		rcUpdate.enrichmentFailedAt = now;
	}

	// Skip permanently (for blocklisted domains)
	if (enrichmentData.enrichmentSkipped !== undefined) {
		rcUpdate.enrichmentSkipped = enrichmentData.enrichmentSkipped;
	}

	// Exempt from enrichment pipelines (connector apps without store pages)
	if (enrichmentData.enrichmentExempt !== undefined) {
		rcUpdate.enrichmentExempt = enrichmentData.enrichmentExempt;
	}

	// Store enrichment error in rich_content JSON blob
	// On failure: write the error message; on success: clear it (null).
	if (enrichmentData.enrichmentError !== undefined) {
		rcUpdate.enrichmentError = enrichmentData.enrichmentError;
	} else if (
		enrichmentData.enrichmentFailedAt === undefined &&
		(enrichmentData.screenshotUrl ||
			enrichmentData.screenshots?.length ||
			enrichmentData.enrichedDescription ||
			enrichmentData.seoDescription ||
			enrichmentData.categories?.length)
	) {
		// Enrichment succeeded — clear any previous error
		rcUpdate.enrichmentError = null;
	}

	updateData.richContent = rcUpdate;

	try {
		await db.update(appCatalog).set(updateData).where(eq(appCatalog.id, id));
	} catch (error) {
		// Log details to help debug D1 failures (field sizes, types)
		const fieldSizes: Record<string, number | string> = {};
		for (const [key, value] of Object.entries(updateData)) {
			if (value === null) fieldSizes[key] = "null";
			else if (typeof value === "string") fieldSizes[key] = value.length;
			else if (Array.isArray(value)) fieldSizes[key] = `array(${value.length})`;
			else if (typeof value === "object")
				fieldSizes[key] = `object(${JSON.stringify(value).length})`;
			else fieldSizes[key] = String(typeof value);
		}
		console.error(
			`[updateCatalogAppEnrichment] D1 update failed for id=${id}:`,
			JSON.stringify(fieldSizes),
		);
		throw error;
	}

	return getCatalogAppById(db, id);
}
