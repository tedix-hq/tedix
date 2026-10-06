/**
 * App Adapter Query Helpers
 * Database queries for adapter configuration management
 *
 * Adapters connect apps to external data sources (Klarna, Shopify, Vector, etc.)
 * Used by the unified MCP engine to dynamically configure data sources per app.
 */

import { and, desc, eq, asc } from "drizzle-orm";
import type { DbClient } from "../client";
import type { AppAdapter, NewAppAdapter } from "../schema/adapters";
import { appAdapters } from "../schema/adapters";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get all adapters for an app
 * Ordered by priority (descending) so higher priority adapters come first
 *
 * @param db - Database client
 * @param appId - App ID to get adapters for
 */
export async function getAdaptersByAppId(
	db: DbClient,
	appId: string,
): Promise<AppAdapter[]> {
	return db
		.select()
		.from(appAdapters)
		.where(eq(appAdapters.appId, appId))
		.orderBy(desc(appAdapters.priority), asc(appAdapters.createdAt));
}

/**
 * Get a single adapter by ID
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 */
export async function getAdapterById(
	db: DbClient,
	adapterId: string,
): Promise<AppAdapter | undefined> {
	return db.query.appAdapters.findFirst({ where: { id: adapterId } });
}

/**
 * Get enabled adapters for an app, ordered by priority
 * Used by the MCP engine to determine which adapters to query
 *
 * @param db - Database client
 * @param appId - App ID
 */
export async function getEnabledAdapters(
	db: DbClient,
	appId: string,
): Promise<AppAdapter[]> {
	return db
		.select()
		.from(appAdapters)
		.where(and(eq(appAdapters.appId, appId), eq(appAdapters.enabled, true)))
		.orderBy(desc(appAdapters.priority), asc(appAdapters.createdAt));
}

/**
 * Get the primary (highest priority enabled) adapter for an app
 * Used when adapterScope is "primary" for a tool
 *
 * @param db - Database client
 * @param appId - App ID
 */
export async function getPrimaryAdapter(
	db: DbClient,
	appId: string,
): Promise<AppAdapter | undefined> {
	const adapters = await getEnabledAdapters(db, appId);
	return adapters[0]; // First is highest priority
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Upsert an adapter
 * Creates a new adapter or updates existing by ID
 *
 * @param db - Database client
 * @param adapter - Adapter data (with or without ID)
 */
export async function upsertAdapter(
	db: DbClient,
	adapter: Omit<NewAppAdapter, "id"> & { id?: string },
): Promise<AppAdapter> {
	const now = new Date().toISOString();

	// If ID provided, check if adapter exists
	if (adapter.id) {
		const existing = await getAdapterById(db, adapter.id);

		if (existing) {
			// Update existing adapter
			await db
				.update(appAdapters)
				.set({
					...adapter,
					updatedAt: now,
				})
				.where(eq(appAdapters.id, adapter.id));

			const updated = await getAdapterById(db, adapter.id);
			if (!updated) {
				throw new Error(`Failed to update adapter: ${adapter.id}`);
			}
			return updated;
		}
	}

	// Create new adapter
	const id = adapter.id || crypto.randomUUID();

	await db.insert(appAdapters).values({
		...adapter,
		id,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getAdapterById(db, id);
	if (!created) {
		throw new Error(`Failed to create adapter: ${id}`);
	}
	return created;
}

/**
 * Delete an adapter by ID
 *
 * @param db - Database client
 * @param adapterId - Adapter ID to delete
 */
export async function deleteAdapter(
	db: DbClient,
	adapterId: string,
): Promise<void> {
	await db.delete(appAdapters).where(eq(appAdapters.id, adapterId));
}

/**
 * Toggle adapter enabled status
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 * @param enabled - New enabled status
 */
export async function toggleAdapterEnabled(
	db: DbClient,
	adapterId: string,
	enabled: boolean,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(appAdapters)
		.set({
			enabled,
			updatedAt: now,
		})
		.where(eq(appAdapters.id, adapterId));
}

/**
 * Update adapter priority
 * Higher priority adapters are queried first in the fallback chain
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 * @param priority - New priority value
 */
export async function updateAdapterPriority(
	db: DbClient,
	adapterId: string,
	priority: number,
): Promise<void> {
	const now = new Date().toISOString();

	await db
		.update(appAdapters)
		.set({
			priority,
			updatedAt: now,
		})
		.where(eq(appAdapters.id, adapterId));
}
