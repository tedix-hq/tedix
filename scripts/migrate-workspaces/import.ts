/**
 * `import`: load one workspace's bundle into its workspace object, chunk by
 * chunk. Each chunk has a stable batch id, so a rerun after a failure skips
 * what already landed and finishes the rest.
 *
 * A remote import first proves its snapshot (see `snapshot-proof.ts`): a
 * validated full snapshot taken at import time whose manifest equals the
 * one every bundle recorded, and historical log coverage. Nothing is written
 * until both hold; there is no override.
 */
import type { BundleStore } from "./bundle";
import { scopedRefs, snapshotCoverage } from "./reconcile";
import {
	batchIdFor,
	renderRow,
	RowDigest,
	rowKey,
	type StoredRow,
} from "./rows";
import type { Scope } from "./scope";
import {
	manifestDifferences,
	snapshotManifest,
	validateSnapshot,
} from "./snapshot-proof";
import type { Snapshot, WorkspaceRef } from "./source";
import { WORKSPACE_TABLES } from "./tables";
import {
	IMPORT_CHUNK_ROWS,
	readAllRows,
	type WorkspaceStoreFactory,
} from "./target";

export interface ImportResult extends WorkspaceRef {
	imported: number;
	duplicates: number;
	ms: number;
}

async function importWorkspace(
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
		// Existing objects can contain earlier imports and object-native rows.
		// Check every table before adding anything; never overwrite a conflict.
		const pending = new Map<string, StoredRow[]>();
		for (const mapping of WORKSPACE_TABLES) {
			const existing = new Map(
				(await readAllRows(store, mapping.table)).map((row) => [
					rowKey(row, mapping.primaryKey),
					row,
				]),
			);
			const missing: StoredRow[] = [];
			for (const row of tables.get(mapping.table) ?? []) {
				const previous = existing.get(rowKey(row, mapping.primaryKey));
				if (!previous) {
					if (
						description.outputAuthority === "object" &&
						(mapping.table === "os_outputs" ||
							mapping.table === "os_output_revisions")
					)
						throw new Error(
							`Import refused: cannot add ${mapping.table} to object-owned workspace ${ref.workspaceId}`,
						);
					missing.push(row);
					continue;
				}
				const carried = Object.fromEntries(
					Object.keys(row).map((column) => [column, previous[column] ?? null]),
				);
				if (renderRow(carried) !== renderRow(row))
					throw new Error(
						`Import refused: existing ${mapping.table} row differs in workspace ${ref.workspaceId}`,
					);
				duplicates += 1;
			}
			pending.set(mapping.table, missing);
		}
		// Parents before children: the order of the mapping file is the insert order.
		for (const mapping of WORKSPACE_TABLES) {
			const rows = pending.get(mapping.table) ?? [];
			for (let index = 0; index * IMPORT_CHUNK_ROWS < rows.length; index += 1) {
				const chunk = rows.slice(
					index * IMPORT_CHUNK_ROWS,
					(index + 1) * IMPORT_CHUNK_ROWS,
				);
				const digest = new RowDigest(mapping.primaryKey);
				for (const row of chunk) digest.add(row);
				const receipt = await store.importRows({
					batchId: batchIdFor(
						ref.workspaceId,
						`${mapping.table}:${digest.hex()}`,
						index,
					),
					table: mapping.table,
					rows: chunk,
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

/**
 * Both gates, before any target is opened. Every finding is listed; one is
 * enough to refuse.
 */
export async function proveSnapshot(
	bundles: BundleStore,
	snapshot: Snapshot,
	scope?: Scope,
	now: Date = new Date(),
): Promise<string[]> {
	const problems = validateSnapshot(snapshot, now);
	const manifest = snapshotManifest(snapshot);
	for (const ref of await scopedRefs(bundles, scope)) {
		const { manifest: bundle } = await bundles.read(ref);
		for (const difference of manifestDifferences(bundle.snapshot, manifest))
			problems.push(`${ref.organizationId}/${ref.workspaceId}: ${difference}`);
	}
	problems.push(...(await snapshotCoverage(bundles, snapshot, scope)).problems);
	return problems;
}

export async function importAll(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	options: {
		snapshot?: Snapshot;
		scope?: Scope;
		onWorkspace?: (result: ImportResult) => void;
	} = {},
): Promise<ImportResult[]> {
	const { snapshot, scope, onWorkspace } = options;
	if (stores.kind === "remote" && !snapshot)
		throw new Error(
			"Remote import refused: pass the snapshot the bundles were exported from (--snapshot main.sql --logs <every log partition>)",
		);
	if (snapshot) {
		const problems = await proveSnapshot(bundles, snapshot, scope);
		if (problems.length)
			throw new Error(`Import refused:\n  ${problems.join("\n  ")}`);
	}
	const results: ImportResult[] = [];
	for (const ref of await scopedRefs(bundles, scope)) {
		const result = await importWorkspace(bundles, stores, ref);
		onWorkspace?.(result);
		results.push(result);
	}
	return results;
}
