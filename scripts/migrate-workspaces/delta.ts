import { createHash } from "node:crypto";
import type { BundleStore } from "./bundle";
import { proveSnapshot } from "./import";
import { scopedRefs } from "./reconcile";
import { renderRow, RowDigest, rowKey, toWire, type StoredRow } from "./rows";
import type { Scope } from "./scope";
import type { Snapshot, WorkspaceRef } from "./source";
import { WORKSPACE_TABLES } from "./tables";
import {
	IMPORT_CHUNK_ROWS,
	readAllRows,
	type DeltaBatch,
	type DeltaReceipt,
	type WorkspaceStoreFactory,
} from "./target";

type Change = DeltaBatch["changes"][number];
export function planDelta(
	before: readonly StoredRow[],
	after: readonly StoredRow[],
): Change[] {
	const indexed = (rows: readonly StoredRow[]) => {
		const result = new Map<string, StoredRow>();
		for (const row of rows) {
			if (typeof row.id !== "string" || !row.id || result.has(row.id))
				throw new Error("Delta rows require unique ids");
			result.set(row.id, row);
		}
		return result;
	};
	const old = indexed(before),
		next = indexed(after);
	return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((id) => {
		const a = old.get(id) ?? null,
			b = next.get(id) ?? null;
		return a && b && renderRow(a) === renderRow(b)
			? []
			: [{ before: a, after: b }];
	});
}

async function validatedTables(bundles: BundleStore, ref: WorkspaceRef) {
	const { manifest, tables } = await bundles.read(ref);
	if (
		manifest.organizationId !== ref.organizationId ||
		manifest.workspaceId !== ref.workspaceId ||
		[...tables.keys()].some((t) => !WORKSPACE_TABLES.some((m) => m.table === t))
	)
		throw new Error("Delta bundle scope or table mismatch");
	for (const mapping of WORKSPACE_TABLES) {
		const rows = tables.get(mapping.table),
			summary = manifest.tables[mapping.table];
		if (!rows || !summary)
			throw new Error(`Missing delta table ${mapping.table}`);
		const digest = new RowDigest(mapping.primaryKey);
		for (const row of rows) digest.add(row);
		if (digest.count !== summary.count || digest.hex() !== summary.sha256)
			throw new Error(`Damaged delta bundle ${mapping.table}`);
	}
	return tables;
}

export interface DeltaResult extends WorkspaceRef {
	receipts: DeltaReceipt[];
	alreadyApplied: number;
}

/** Compare the retained staged bundle with a new frozen source, never with an inferred winner. */
export async function applyDeltaAll(
	baseline: BundleStore,
	final: BundleStore,
	stores: WorkspaceStoreFactory,
	options: {
		snapshot: Snapshot;
		frozenAt: string;
		freezeRef: string;
		scope?: Scope;
		onReceipt?: (ref: WorkspaceRef, receipt: DeltaReceipt) => void;
	},
): Promise<DeltaResult[]> {
	const frozenAt = Date.parse(options.frozenAt);
	if (
		stores.kind !== "remote" ||
		!options.freezeRef.trim() ||
		!Number.isFinite(frozenAt) ||
		frozenAt > Date.now() ||
		frozenAt >
			Date.parse(
				options.snapshot.capture?.startedAt ??
					options.snapshot.takenAt.toISOString(),
			)
	)
		throw new Error("Delta requires a fresh capture begun after the freeze");
	const problems = await proveSnapshot(final, options.snapshot, options.scope);
	if (problems.length) throw new Error(`Delta refused: ${problems.join("; ")}`);
	const refs = await scopedRefs(final, options.scope);
	const baselineRefs = new Set(
		(await baseline.list()).map((r) => `${r.organizationId}/${r.workspaceId}`),
	);
	for (const ref of refs)
		if (!baselineRefs.has(`${ref.organizationId}/${ref.workspaceId}`))
			throw new Error("Delta baseline does not cover every selected workspace");
	const results: DeltaResult[] = [];
	for (const ref of refs) {
		const old = await validatedTables(baseline, ref),
			next = await validatedTables(final, ref);
		const store = await stores.open(ref);
		try {
			const description = await store.describe();
			if (
				description.organizationId !== ref.organizationId ||
				description.workspaceId !== ref.workspaceId ||
				description.jurisdiction !== "eu"
			)
				throw new Error("Delta target scope or jurisdiction mismatch");
			const pending = new Map<string, Change[]>();
			let alreadyApplied = 0;
			for (const { table } of WORKSPACE_TABLES) {
				const current = new Map(
					(await readAllRows(store, table)).map((row) => [
						rowKey(row, ["id"]),
						row,
					]),
				);
				const changes: Change[] = [];
				for (const change of planDelta(old.get(table)!, next.get(table)!)) {
					const actual =
						current.get(rowKey((change.before ?? change.after)!, ["id"])) ??
						null;
					if (renderRowOrNull(actual) === renderRowOrNull(change.after)) {
						alreadyApplied++;
						continue;
					}
					if (renderRowOrNull(actual) !== renderRowOrNull(change.before))
						throw new Error(
							`Delta conflict in ${table}; staged row no longer equals its baseline`,
						);
					changes.push(change);
				}
				pending.set(table, changes);
			}
			let generation = description.importGeneration;
			const count = [...pending.values()].reduce(
				(n, changes) => n + changes.length,
				0,
			);
			if ((await store.describe()).importGeneration !== generation)
				throw new Error("Import changed during delta preflight");
			if (
				count &&
				(!store.applyDelta ||
					description.outputAuthority !== "shared" ||
					!Number.isSafeInteger(generation) ||
					generation! < 1)
			)
				throw new Error("Delta requires staged shared authority");
			const receipts: DeltaReceipt[] = [];
			const phases = [WORKSPACE_TABLES, [...WORKSPACE_TABLES].reverse()];
			for (let phase = 0; phase < phases.length; phase++)
				for (const { table } of phases[phase]!) {
					const changes = pending
						.get(table)!
						.filter((change) =>
							phase === 0 ? change.after !== null : change.after === null,
						);
					for (
						let offset = 0;
						offset < changes.length;
						offset += IMPORT_CHUNK_ROWS
					) {
						const chunk = changes.slice(offset, offset + IMPORT_CHUNK_ROWS);
						const hash = createHash("sha256")
							.update(
								JSON.stringify(
									chunk.map((c) => ({
										before: c.before && toWire(c.before),
										after: c.after && toWire(c.after),
									})),
								),
							)
							.digest("hex");
						const receipt = await store.applyDelta!({
							batchId: `delta:${generation}:${table}:${hash}`,
							table,
							changes: chunk,
							importGeneration: generation!,
							freezeRef: options.freezeRef,
						});
						options.onReceipt?.(ref, receipt);
						if (receipt.importGeneration !== generation! + 1)
							throw new Error(
								"Unexpected delta generation; read target and reconcile",
							);
						generation = receipt.importGeneration;
						receipts.push(receipt);
					}
				}
			results.push({ ...ref, receipts, alreadyApplied });
		} finally {
			await store.close();
		}
	}
	return results;
}
function renderRowOrNull(row: StoredRow | null) {
	return row === null ? null : renderRow(row);
}
