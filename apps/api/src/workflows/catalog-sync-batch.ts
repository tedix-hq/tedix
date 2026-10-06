interface CatalogSyncItem {
	name: string;
	source: string;
	sourceAppId: string;
}

interface BulkSyncResult {
	inserted: number;
	updated: number;
	errors: string[];
}

export interface CatalogSyncBatchResult extends BulkSyncResult {
	failed: number;
}

interface CatalogSyncBatchDependencies<T extends CatalogSyncItem> {
	normalize: (items: T[]) => Promise<T[]>;
	sync: (items: T[]) => Promise<BulkSyncResult>;
}

/**
 * Normalize and upsert one bounded Catalog batch. The caller runs this inside a
 * durable Workflow step; stable asset keys and catalog upserts make retries
 * idempotent.
 */
export async function runCatalogSyncBatch<T extends CatalogSyncItem>(
	items: T[],
	dependencies: CatalogSyncBatchDependencies<T>,
): Promise<CatalogSyncBatchResult> {
	const normalized = await dependencies.normalize(items);

	try {
		const result = await dependencies.sync(normalized);
		return {
			...result,
			failed: result.errors.length,
		};
	} catch (error) {
		const batchError = error instanceof Error ? error.message : String(error);
		let inserted = 0;
		let updated = 0;
		let failed = 0;
		const errors = [`Catalog batch failed; retrying per item: ${batchError}`];

		for (const item of normalized) {
			try {
				const result = await dependencies.sync([item]);
				inserted += result.inserted;
				updated += result.updated;
				failed += result.errors.length;
				errors.push(...result.errors);
			} catch (itemError) {
				failed += 1;
				const message =
					itemError instanceof Error ? itemError.message : String(itemError);
				errors.push(
					`Catalog item failed ${item.name} (${item.source}:${item.sourceAppId}): ${message}`,
				);
			}
		}

		return { inserted, updated, failed, errors };
	}
}
