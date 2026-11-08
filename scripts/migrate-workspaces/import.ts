/**
 * `import`: load one workspace's bundle into its workspace object, chunk by
 * chunk. Each chunk has a stable batch id, so a rerun after a failure skips
 * what already landed and finishes the rest.
 */
import type { BundleStore } from "./bundle";
import { batchIdFor, RowDigest } from "./rows";
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
	// Local copies can establish parity; the current workspace-only protocol
	// cannot yet preserve organization memory authorization for a live move.
	if (stores.kind === "remote")
		throw new Error(
			"Remote workspace import is blocked: organization memory authorization parity, a validated full snapshot and historical log coverage must be established before customer data moves",
		);
	const started = performance.now();
	const { manifest, tables } = await bundles.read(ref);
	if (
		manifest.organizationId !== ref.organizationId ||
		manifest.workspaceId !== ref.workspaceId
	)
		throw new Error(`bundle for ${ref.workspaceId} names another workspace`);
	for (const table of new Set([
		...Object.keys(manifest.tables),
		...tables.keys(),
	]))
		if (!WORKSPACE_TABLES.some((mapping) => mapping.table === table))
			throw new Error(`bundle contains unmapped table ${table}`);
	// Validate every table before opening the target, including derived tables:
	// post-import reconciliation is too late to catch changed policy columns.
	for (const mapping of WORKSPACE_TABLES) {
		const summary = manifest.tables[mapping.table];
		const rows = tables.get(mapping.table);
		if (!summary || !rows)
			throw new Error(`bundle has no rows or summary for ${mapping.table}`);
		const digest = new RowDigest(mapping.primaryKey);
		for (const row of rows) digest.add(row);
		if (digest.count !== summary.count || digest.hex() !== summary.sha256)
			throw new Error(
				`bundle rows for ${mapping.table} do not match its manifest`,
			);
		if (mapping.domain === "memory" && summary.reassigned !== 0)
			throw new Error(
				`bundle cannot reassign organization memory: ${mapping.table}`,
			);
	}
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
