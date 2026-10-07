/**
 * App Catalog Queries — Get single app + slug/update/delete operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { eq, sql } from "drizzle-orm";
import { apps } from "../../schema/apps";
import {
	appCatalog,
	appCatalogStoreListings,
	type CatalogApp,
	type CatalogStoreListing,
	type NewCatalogApp,
	type NewCatalogStoreListing,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// GET SINGLE APP
// =============================================================================

/**
 * Get a catalog app by internal ID
 */
export async function getCatalogAppById(
	db: Database,
	id: string,
): Promise<CatalogApp | null> {
	return (await db.query.appCatalog.findFirst({ where: { id } })) ?? null;
}

/**
 * Get a catalog app by slug
 * Used for SEO-friendly URLs (e.g., /marketplace/kleinanzeigen)
 */
export async function getCatalogAppBySlug(
	db: Database,
	slug: string,
): Promise<CatalogApp | null> {
	const result = await db
		.select()
		.from(appCatalog)
		.where(eq(appCatalog.slug, slug))
		.limit(1);

	return result[0] ?? null;
}

/**
 * Sanitize a string into a URL-friendly slug.
 * Strips non-ASCII characters (Korean, Chinese, Japanese, etc.) and normalizes.
 */
function sanitizeToSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "") // Remove non-ASCII and special characters
		.replace(/\s+/g, "-") // Replace spaces with hyphens
		.replace(/-+/g, "-") // Replace multiple hyphens with single
		.replace(/^-|-$/g, "") // Remove leading/trailing hyphens
		.slice(0, 50); // Max 50 chars
}

/**
 * Check whether a slug is usable: at least 2 chars, not purely numeric/dashes.
 */
function isValidSlug(slug: string): boolean {
	if (slug.length < 2) return false;
	// Reject slugs that are only dashes and/or digits (e.g. "", "-2", "123")
	if (/^[-0-9]*$/.test(slug)) return false;
	return true;
}

/**
 * Extract a slug fallback from a source app ID by stripping common prefixes.
 * e.g. "asdk_app_elpoint" -> "elpoint", "connector_my-app" -> "my-app"
 */
function slugFromSourceAppId(sourceAppId: string): string {
	const stripped = sourceAppId
		.replace(/^asdk_app_/, "")
		.replace(/^connector_/, "");
	return sanitizeToSlug(stripped);
}

/**
 * Extract a slug fallback from a URL's hostname.
 * e.g. "https://mcp.notion.com/mcp" -> "notion"
 */
function slugFromBaseUrl(baseUrl: string): string {
	try {
		const hostname = new URL(baseUrl).hostname;
		// Remove common prefixes/suffixes: www., mcp., .com, .io, etc.
		const cleaned = hostname
			.replace(/^(www\.|mcp\.|api\.)/, "")
			.replace(/\.(com|io|dev|app|org|net|co)$/, "");
		return sanitizeToSlug(cleaned);
	} catch {
		return sanitizeToSlug(baseUrl);
	}
}

/**
 * Generate a URL-friendly slug from an app name, with fallbacks for non-Latin names.
 *
 * When the name produces an empty or invalid slug (e.g. Korean "엘포인트"),
 * falls back to storeSourceId (the store SDK app ID, e.g. "asdk_app_elpoint")
 * or baseUrl domain in that order.
 *
 * Note: `storeSourceId` is the raw store identifier from the scan pipeline; the
 * persisted per-store id lives on `app_catalog_store_listings.source_app_id`.
 */
export function generateSlug(
	name: string,
	fallbacks?: { storeSourceId?: string | null; baseUrl?: string | null },
): string {
	const fromName = sanitizeToSlug(name);
	if (isValidSlug(fromName)) return fromName;

	// Fallback 1: derive from store SDK source ID (e.g. "asdk_app_elpoint" → "elpoint")
	if (fallbacks?.storeSourceId) {
		const fromSourceId = slugFromSourceAppId(fallbacks.storeSourceId);
		if (isValidSlug(fromSourceId)) return fromSourceId;
	}

	// Fallback 2: derive from baseUrl domain
	if (fallbacks?.baseUrl) {
		const fromUrl = slugFromBaseUrl(fallbacks.baseUrl);
		if (isValidSlug(fromUrl)) return fromUrl;
	}

	// Last resort: generate a random slug
	return `app-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Generate a unique slug for catalog apps, handling collisions by appending suffix
 */
export async function generateUniqueCatalogAppSlug(
	db: Database,
	name: string,
	options?: {
		excludeId?: string;
		storeSourceId?: string | null;
		baseUrl?: string | null;
	},
): Promise<string> {
	const baseSlug = generateSlug(name, {
		storeSourceId: options?.storeSourceId,
		baseUrl: options?.baseUrl,
	});
	let slug = baseSlug;
	let counter = 2;

	while (true) {
		// Check if slug exists
		const existing = await db
			.select({ id: appCatalog.id })
			.from(appCatalog)
			.where(eq(appCatalog.slug, slug))
			.limit(1);

		// If no conflict, or conflict is with the same app (for updates), use this slug
		if (
			existing.length === 0 ||
			(options?.excludeId && existing[0]?.id === options.excludeId)
		) {
			return slug;
		}
		if (slug === baseSlug && (await releaseRetiredCatalogSlug(db, slug))) {
			return slug;
		}

		// Add suffix and try again
		slug = `${baseSlug}-${counter}`;
		counter++;

		// Safety limit
		if (counter > 100) {
			// Use a random suffix if we've tried too many times
			slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
			break;
		}
	}

	return slug;
}

/**
 * A disabled entry that no app was ever built from holds its slug only by
 * history. Move it aside so the vendor's live entry gets the plain name
 * instead of a numbered one (`resend-2`), which every base app, connection
 * provider, tenant install and Code Mode namespace would otherwise inherit.
 */
export async function releaseRetiredCatalogSlug(
	db: Database,
	slug: string,
): Promise<boolean> {
	const [holder] = await db
		.select({ id: appCatalog.id, status: appCatalog.status })
		.from(appCatalog)
		.where(eq(appCatalog.slug, slug))
		.limit(1);
	if (!holder || holder.status !== "DISABLED") return false;
	const [builtFrom] = await db
		.select({ id: apps.id })
		.from(apps)
		.where(eq(apps.catalogAppId, holder.id))
		.limit(1);
	if (builtFrom) return false;
	await updateCatalogAppSlug(
		db,
		holder.id,
		`${slug}-retired-${holder.id.slice(0, 8)}`,
	);
	return true;
}

/**
 * Update an app's slug
 */
export async function updateCatalogAppSlug(
	db: Database,
	id: string,
	slug: string,
): Promise<void> {
	await db
		.update(appCatalog)
		.set({
			slug,
			updatedAt: sql`datetime('now')`,
		})
		.where(eq(appCatalog.id, id));
}

export async function updateCatalogAppScanAuth(
	db: Database,
	id: string,
	encryptedHeaders: string | null,
): Promise<void> {
	await db
		.update(appCatalog)
		.set({
			scanAuthHeaders: encryptedHeaders,
			updatedAt: sql`datetime('now')`,
		})
		.where(eq(appCatalog.id, id));
}

export async function updateCatalogAppScanConnection(
	db: Database,
	id: string,
	connection: {
		connectionId: string;
		connectionHeader: string;
		connectionTemplate: string;
		organizationId: string;
	},
): Promise<void> {
	await db
		.update(appCatalog)
		.set({
			scanConnectionId: connection.connectionId,
			scanConnectionHeader: connection.connectionHeader,
			scanConnectionTemplate: connection.connectionTemplate,
			scanOrganizationId: connection.organizationId,
			updatedAt: sql`datetime('now')`,
		})
		.where(eq(appCatalog.id, id));
}

export async function updateCatalogApp(
	db: Database,
	id: string,
	data: Partial<NewCatalogApp>,
): Promise<CatalogApp | null> {
	const existing = await getCatalogAppById(db, id);
	if (!existing) return null;

	await db
		.update(appCatalog)
		.set({
			...data,
			updatedAt: sql`datetime('now')`,
		})
		.where(eq(appCatalog.id, id));

	return getCatalogAppById(db, id);
}

export async function updateCatalogStoreListing(
	db: Database,
	id: string,
	data: Partial<NewCatalogStoreListing>,
): Promise<CatalogStoreListing | null> {
	const existing = await db
		.select()
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.id, id))
		.limit(1);
	if (!existing[0]) return null;

	await db
		.update(appCatalogStoreListings)
		.set({
			...data,
			lastSyncedAt: data.lastSyncedAt ?? new Date().toISOString(),
		})
		.where(eq(appCatalogStoreListings.id, id));

	const updated = await db
		.select()
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.id, id))
		.limit(1);
	return updated[0] ?? null;
}

export async function deleteCatalogApp(
	db: Database,
	id: string,
): Promise<{ deleted: boolean; name: string | null }> {
	const existing = await getCatalogAppById(db, id);
	if (!existing) return { deleted: false, name: null };

	await db.delete(appCatalog).where(eq(appCatalog.id, id));
	return { deleted: true, name: existing.name };
}
