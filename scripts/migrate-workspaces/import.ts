/**
 * `import`: load one workspace's bundle into its workspace object, chunk by
 * chunk. Each chunk has a stable batch id, so a rerun after a failure skips
 * what already landed and finishes the rest.
 */
import type { BundleStore } from "./bundle";
import { batchIdFor } from "./rows";
import type { WorkspaceRef } from "./source";
import { WORKSPACE_TABLES } from "./tables";
import { IMPORT_CHUNK_ROWS, type WorkspaceStoreFactory } from "./target";

export interface ImportResult extends WorkspaceRef {
	imported: number;
	duplicates: number;
	ms: number;
}

export async function importWorkspace(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	ref: WorkspaceRef,
): Promise<ImportResult> {
	const started = performance.now();
	const { manifest, tables } = await bundles.read(ref);
	if (
		manifest.organizationId !== ref.organizationId ||
		manifest.workspaceId !== ref.workspaceId
	)
		throw new Error(`bundle for ${ref.workspaceId} names another workspace`);
	const store = await stores.open(ref);
	let imported = 0;
	let duplicates = 0;
	try {
		const description = await store.describe();
		if (
			description.organizationId !== ref.organizationId ||
			description.workspaceId !== ref.workspaceId
		)
			throw new Error(
				`object for ${ref.workspaceId} is bound to another scope`,
			);
		// Parents before children: the order of the mapping file is the insert order.
		for (const mapping of WORKSPACE_TABLES) {
			if (mapping.derivedInObject) continue; // the object builds these rows itself
			const rows = tables.get(mapping.table) ?? [];
			for (let index = 0; index * IMPORT_CHUNK_ROWS < rows.length; index += 1) {
				const receipt = await store.importRows({
					batchId: batchIdFor(ref.workspaceId, mapping.table, index),
					table: mapping.table,
					rows: rows.slice(
						index * IMPORT_CHUNK_ROWS,
						(index + 1) * IMPORT_CHUNK_ROWS,
					),
				});
				if (receipt.status === "duplicate") duplicates += receipt.rowCount;
				else imported += receipt.rowCount;
			}
		}
	} finally {
		await store.close();
	}
	return { ...ref, imported, duplicates, ms: performance.now() - started };
}

export async function importAll(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	onWorkspace?: (result: ImportResult) => void,
): Promise<ImportResult[]> {
	const results: ImportResult[] = [];
	for (const ref of await bundles.list()) {
		const result = await importWorkspace(bundles, stores, ref);
		onWorkspace?.(result);
		results.push(result);
	}
	return results;
}
