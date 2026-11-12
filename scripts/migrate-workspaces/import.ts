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
import { planObjectOwnedMerge, type MergePlan } from "./merge";
import { scopedRefs, snapshotCoverage } from "./reconcile";
import {
	batchIdFor,
	renderRow,
	RowDigest,
	rowKey,
	type StoredRow,
} from "./rows";
import { refKey, type Scope } from "./scope";
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
	/** Set for a workspace merged with `mergeObjectOwned`; `planOnly` wrote nothing. */
	merge?: Pick<MergePlan, "objectWins" | "notAdded" | "objectOnly"> & {
		toAdd: Array<{ table: string; key: string }>;
		planOnly: boolean;
	};
}

async function importWorkspace(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	ref: WorkspaceRef,
	merge?: { planOnly: boolean },
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
	let merged: ImportResult["merge"];
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
		const existing = new Map<string, StoredRow[]>();
		for (const mapping of WORKSPACE_TABLES)
			existing.set(mapping.table, await readAllRows(store, mapping.table));
		if (merge) {
			if (description.outputAuthority !== "object")
				throw new Error(
					`Merge refused: workspace ${ref.workspaceId} is not object-owned (authority ${description.outputAuthority ?? "unknown"})`,
				);
			const plan = planObjectOwnedMerge(tables, existing);
			duplicates += plan.duplicates;
			for (const [table, rows] of plan.add) pending.set(table, rows);
			merged = {
				objectWins: plan.objectWins,
				notAdded: plan.notAdded,
				objectOnly: plan.objectOnly,
				toAdd: WORKSPACE_TABLES.flatMap((mapping) =>
					(plan.add.get(mapping.table) ?? []).map((row) => ({
						table: mapping.table,
						key: rowKey(row, mapping.primaryKey),
					})),
				),
				planOnly: merge.planOnly,
			};
			if (merge.planOnly) pending.clear();
		} else
			for (const mapping of WORKSPACE_TABLES) {
				const byKey = new Map(
					existing
						.get(mapping.table)!
						.map((row) => [rowKey(row, mapping.primaryKey), row]),
				);
				const missing: StoredRow[] = [];
				for (const row of tables.get(mapping.table) ?? []) {
					const previous = byKey.get(rowKey(row, mapping.primaryKey));
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
						Object.keys(row).map((column) => [
							column,
							previous[column] ?? null,
						]),
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
	return {
		...ref,
		imported,
		duplicates,
		ms: performance.now() - started,
		...(merged ? { merge: merged } : {}),
	};
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
		/**
		 * Object-owned workspaces to merge instead of refusing (see `merge.ts`).
		 * Each must also be in `scope`; no other workspace is treated this way.
		 */
		mergeObjectOwned?: Scope;
		/** With `mergeObjectOwned`: report the plan and write nothing. */
		mergePlanOnly?: boolean;
		onWorkspace?: (result: ImportResult) => void;
	} = {},
): Promise<ImportResult[]> {
	const { snapshot, scope, mergeObjectOwned, onWorkspace } = options;
	if (options.mergePlanOnly && !mergeObjectOwned)
		throw new Error("A merge plan needs the workspaces to merge");
	for (const key of mergeObjectOwned?.keys ?? [])
		if (!scope?.keys.has(key))
			throw new Error(
				`Merge refused: ${key} must also be named in the scope of this run`,
			);
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
		const result = await importWorkspace(
			bundles,
			stores,
			ref,
			mergeObjectOwned?.keys.has(refKey(ref))
				? { planOnly: options.mergePlanOnly === true }
				: undefined,
		);
		onWorkspace?.(result);
		results.push(result);
	}
	return results;
}
