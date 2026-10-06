/** Item query helpers, isolated from app and job query graphs. */

import type { LayoutItemSchemaType as LayoutItem } from "@tedix/api-contract/schemas/layout";
import { and, desc, eq, inArray, like, or } from "drizzle-orm";
import type { DbClient } from "../client";
import type { NewItem } from "../schema/items";
import { items, itemToLayoutItem } from "../schema/items";
import { chunkForBoundParams } from "../utils/batch";
import { getAffectedRows } from "../utils/d1-result";

/**
 * Get item by ID
 */
export async function getItemById(db: DbClient, id: string) {
	return db.query.items.findFirst({ where: { id } });
}

/**
 * Get items by app
 */
export async function getItemsByApp(
	db: DbClient,
	appId: string,
	opts?: { limit?: number; offset?: number },
) {
	return db
		.select()
		.from(items)
		.where(eq(items.appId, appId))
		.orderBy(desc(items.createdAt))
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);
}

/**
 * Search items by title or description
 */
export async function searchItems(
	db: DbClient,
	appId: string,
	query: string,
	opts?: { limit?: number },
) {
	const searchPattern = `%${query}%`;

	return db
		.select()
		.from(items)
		.where(
			and(
				eq(items.appId, appId),
				or(
					like(items.title, searchPattern),
					like(items.description, searchPattern),
				),
			),
		)
		.orderBy(desc(items.createdAt))
		.limit(opts?.limit ?? 20);
}

/**
 * Upsert items (insert or update if external_id exists)
 */
export async function upsertItems(
	db: DbClient,
	appId: string,
	itemsData: Array<Omit<NewItem, "appId">>,
) {
	let inserted = 0;
	let updated = 0;
	const errors: string[] = [];

	for (const itemData of itemsData) {
		try {
			const now = new Date().toISOString();

			// Check if item with external_id already exists
			let existing = null;
			if (itemData.externalId) {
				const rows = await db
					.select()
					.from(items)
					.where(
						and(
							eq(items.appId, appId),
							eq(items.externalId, itemData.externalId),
						),
					)
					.limit(1);
				existing = rows[0] ?? null;
			}

			if (existing) {
				// Update existing item
				await db
					.update(items)
					.set({
						...itemData,
						updatedAt: now,
					})
					.where(eq(items.id, existing.id));
				updated++;
			} else {
				// Insert new item
				const id = itemData.id || crypto.randomUUID();
				await db.insert(items).values({
					...itemData,
					id,
					appId,
					createdAt: now,
					updatedAt: now,
				});
				inserted++;
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : "Unknown error";
			errors.push(`Failed to upsert item "${itemData.title}": ${errorMsg}`);
		}
	}

	return { inserted, updated, errors };
}

/**
 * Delete item by ID
 * @returns true if deletion was successful (no error thrown)
 */
export async function deleteItem(db: DbClient, id: string): Promise<boolean> {
	await db.delete(items).where(eq(items.id, id));
	return true;
}

/**
 * Delete all items for an app
 */
export async function deleteItemsByApp(db: DbClient, appId: string) {
	const result = await db.delete(items).where(eq(items.appId, appId));
	return getAffectedRows(result);
}

/**
 * Get item count for an app
 */
export async function getItemCount(db: DbClient, appId: string) {
	return db.$count(items, eq(items.appId, appId));
}

/**
 * Get multiple items by IDs for widget display (returns LayoutItem format)
 * Used by semantic search to fetch full data after Vectorize query
 * Preserves order of input IDs for ranking stability
 */
export async function getItemsByIds(
	db: DbClient,
	ids: string[],
): Promise<LayoutItem[]> {
	if (ids.length === 0) return [];

	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	const itemMap = new Map<string, typeof items.$inferSelect>();
	for (const chunk of chunkForBoundParams([...new Set(ids)], 50)) {
		const rawItems = await db
			.select()
			.from(items)
			.where(inArray(items.id, chunk));
		for (const item of rawItems) itemMap.set(item.id, item);
	}

	// Return items in the order of input IDs (preserves Vectorize ranking)
	return ids
		.map((id) => itemMap.get(id))
		.filter((item): item is NonNullable<typeof item> => item !== undefined)
		.map(itemToLayoutItem);
}
