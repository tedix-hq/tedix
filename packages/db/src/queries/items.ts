/** Item query helpers, isolated from app and job query graphs. */

import { and, eq, ne, notExists, or, sql, type SQLWrapper } from "drizzle-orm";
import type { DbClient } from "../client";
import { alias } from "drizzle-orm/sqlite-core";
import { coreTable } from "../core-store/client";
import { coreStore } from "../core-store/dialect";
import { batchNonEmpty } from "../utils/batch";
import type { NewItem } from "../schema/items";
import { items as schemaItems } from "../schema/items";

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
	const items = coreTable(db, schemaItems);
	return db
		.select()
		.from(items)
		.where(eq(items.appId, appId))
		.orderBy(sql`${items.createdAt} DESC NULLS LAST`)
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
	const items = coreTable(db, schemaItems);
	// Fold ASCII only, preserving SQLite search semantics without LIKE's length cap.
	const lower = (value: SQLWrapper) =>
		coreStore(db) === "postgres"
			? sql`translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
			: sql`lower(${value})`;
	const contains = (value: SQLWrapper) =>
		coreStore(db) === "postgres"
			? sql`strpos(${lower(value)}, ${lower(sql`${query}`)}) > 0`
			: sql`instr(${lower(value)}, ${lower(sql`${query}`)}) > 0`;
	return db
		.select()
		.from(items)
		.where(
			and(
				eq(items.appId, appId),
				or(
					contains(items.title),
					contains(sql`coalesce(${items.description}, '')`),
				),
			),
		)
		.orderBy(sql`${items.createdAt} DESC NULLS LAST`)
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
	const items = coreTable(db, schemaItems);
	const now = new Date().toISOString();
	const errors: string[] = [];
	const groups = itemsData.flatMap((itemData) => {
		try {
			if (itemData.title == null || itemData.vertical == null)
				throw new Error("title and vertical are required");
			const current = alias(items, "current_item");
			const taken = alias(items, "taken_item");
			const match = db
				.select({ id: current.id })
				.from(current)
				.where(
					and(
						eq(current.appId, appId),
						eq(current.externalId, itemData.externalId ?? ""),
					),
				)
				.limit(1);
			const update = itemData.externalId
				? db
						.update(items)
						.set({ ...itemData, updatedAt: now })
						.where(
							and(
								eq(items.id, match),
								itemData.id !== undefined
									? notExists(
											db
												.select({ id: taken.id })
												.from(taken)
												.where(
													and(
														eq(taken.id, itemData.id),
														ne(taken.id, items.id),
													),
												),
										)
									: undefined,
								itemData.url != null
									? notExists(
											db
												.select({ id: taken.id })
												.from(taken)
												.where(
													and(
														eq(taken.appId, appId),
														eq(taken.url, itemData.url),
														ne(taken.id, items.id),
													),
												),
										)
									: undefined,
							),
						)
						.returning({ id: items.id })
				: undefined;
			const insert = db
				.insert(items)
				.values({
					...itemData,
					id: itemData.externalId
						? sql`coalesce((${match}), ${itemData.id || crypto.randomUUID()})`
						: itemData.id || crypto.randomUUID(),
					appId,
					createdAt: now,
					updatedAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: items.id });
			// Isolate serialization failures before submitting the atomic batch.
			update?.toSQL();
			insert.toSQL();
			return [{ itemData, statements: update ? [update, insert] : [insert] }];
		} catch (error) {
			errors.push(
				`Failed to upsert item "${itemData.title}": ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return [];
		}
	});
	if (!groups.length) return { inserted: 0, updated: 0, errors };
	try {
		const results = await db.batch(
			batchNonEmpty(groups.flatMap((group) => group.statements)),
		);
		let index = 0;
		let inserted = 0;
		let updated = 0;
		for (const { itemData, statements } of groups) {
			const changed = statements.length === 2 ? results[index++]!.length : 0;
			const created = results[index++]!.length;
			updated += changed;
			inserted += created;
			if (!changed && !created)
				errors.push(
					`Failed to upsert item "${itemData.title}": conflicts with an existing item`,
				);
		}
		return { inserted, updated, errors };
	} catch (error) {
		// No write survives a rejected batch; never report rolled-back rows as saved.
		return {
			inserted: 0,
			updated: 0,
			errors: errors.concat(
				groups.map(
					({ itemData }) =>
						`Failed to upsert item "${itemData.title}": ${error instanceof Error ? error.message : "Unknown error"}`,
				),
			),
		};
	}
}

/**
 * Delete item by ID
 * @returns true if deletion was successful (no error thrown)
 */
export async function deleteItem(db: DbClient, id: string): Promise<boolean> {
	const items = coreTable(db, schemaItems);
	await db.delete(items).where(eq(items.id, id));
	return true;
}

/**
 * Delete all items for an app
 */
export async function deleteItemsByApp(db: DbClient, appId: string) {
	const items = coreTable(db, schemaItems);
	const deleted = await db
		.delete(items)
		.where(eq(items.appId, appId))
		.returning({ id: items.id });
	return deleted.length;
}

/**
 * Get item count for an app
 */
export async function getItemCount(db: DbClient, appId: string) {
	const items = coreTable(db, schemaItems);
	return db.$count(items, eq(items.appId, appId));
}
